// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Dead Man's Hand v2
/// @notice Inactivity-gated, non-custodial sweeping authorized by two phrase-derived signers.
/// @dev Invalid signatures return after consuming the fee. Reverting would make spam free.
contract DeadMansHandV2 is EIP712, ReentrancyGuard {
    enum VaultState {
        ACTIVE,
        CLAIMED,
        DEACTIVATED
    }

    enum TokenType {
        ERC20,
        ERC721
    }

    struct TokenEntry {
        address token;
        TokenType tokenType;
    }

    struct Vault {
        address owner;
        address signerA;
        address signerB;
        bytes32 vaultSalt;
        uint64 lastPing;
        uint64 inactivityPeriod;
        uint256 nonce;
        VaultState state;
        TokenEntry[] tokens;
    }

    struct VaultView {
        address owner;
        address signerA;
        address signerB;
        bytes32 vaultSalt;
        uint64 lastPing;
        uint64 inactivityPeriod;
        uint256 nonce;
        VaultState state;
    }

    uint256 public constant MAX_TOKENS = 50;
    uint256 public constant MAX_NFT_TRANSFERS_PER_CLAIM = 20;
    uint64 public constant MIN_INACTIVITY_PERIOD = 1 minutes;
    uint64 public constant MAX_INACTIVITY_PERIOD = 3650 days;
    uint32 public constant MAX_FEE_DOUBLINGS = 7;
    uint64 public constant COOLDOWN_DURATION = 1 hours;
    uint64 public constant STALE_SIGNATURE_GRACE_PERIOD = 5 minutes;
    uint256 public constant MAX_BASE_CLAIM_FEE = type(uint256).max >> MAX_FEE_DOUBLINGS;

    uint256 private constant READ_CALL_GAS = 40_000;
    uint256 private constant TRANSFER_CALL_GAS = 150_000;
    bytes4 private constant ERC721_ENUMERABLE_INTERFACE_ID = 0x780e9d63;

    bytes32 public constant REASON_BALANCE_READ_FAILED = keccak256("BALANCE_READ_FAILED");
    bytes32 public constant REASON_ALLOWANCE_READ_FAILED = keccak256("ALLOWANCE_READ_FAILED");
    bytes32 public constant REASON_TRANSFER_FAILED = keccak256("TRANSFER_FAILED");
    bytes32 public constant REASON_NOT_ENUMERABLE = keccak256("NOT_ENUMERABLE");
    bytes32 public constant REASON_ENUMERATION_FAILED = keccak256("ENUMERATION_FAILED");
    bytes32 public constant REASON_NFT_LIMIT_REACHED = keccak256("NFT_LIMIT_REACHED");

    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "ClaimAuthorization(uint256 vaultId,address destination,uint256 nonce)"
    );

    uint256 public immutable baseClaimFee;
    address public immutable feeRecipient;
    uint256 public vaultCount;

    mapping(uint256 vaultId => Vault vault) private _vaults;
    mapping(address owner => uint256[] vaultIds) private _ownerVaults;
    mapping(address owner => uint256 vaultId) public liveVaultOf;
    mapping(uint256 vaultId => mapping(address caller => uint32 count)) public callerFailedAttempts;
    mapping(uint256 vaultId => mapping(address caller => uint64 until)) public callerCooldownUntil;
    mapping(uint256 vaultId => uint64 timestamp) private _lastSuccessfulClaimAt;
    mapping(uint256 vaultId => mapping(address token => bool registered)) private _tokenRegistered;

    error VaultNotFound();
    error NotOwner();
    error VaultNotActive();
    error VaultIsDeactivated();
    error VaultNotYetClaimable();
    error CallerInCooldown();
    error IncorrectFee();
    error InvalidDestination();
    error TooManyTokens();
    error DuplicateToken();
    error TokenNotRegistered();
    error InvalidToken();
    error InvalidSigners();
    error InvalidPeriod();
    error InvalidVaultSalt();
    error LiveVaultAlreadyExists();
    error FeeForwardFailed();
    error InvalidBaseClaimFee();
    error StaleClaimSignatures();

    event VaultCreated(
        uint256 indexed vaultId,
        address indexed owner,
        address signerA,
        address signerB,
        bytes32 vaultSalt,
        uint64 inactivityPeriod
    );
    event TokenAdded(uint256 indexed vaultId, address indexed token, TokenType tokenType);
    event TokenRemoved(uint256 indexed vaultId, address indexed token);
    event Pinged(uint256 indexed vaultId, uint64 timestamp);
    event VaultDeactivated(uint256 indexed vaultId);
    event ClaimFailed(uint256 indexed vaultId, address indexed caller);
    event ClaimExecuted(uint256 indexed vaultId, address indexed destination, address indexed caller);
    event ERC20Swept(uint256 indexed vaultId, address indexed token, address indexed destination, uint256 amount);
    event ERC721Swept(
        uint256 indexed vaultId,
        address indexed token,
        address indexed destination,
        uint256 tokenId
    );
    event TokenSkipped(uint256 indexed vaultId, address indexed token, bytes32 reason);
    event SweepLimitReached(uint256 indexed vaultId);
    event FeeForwarded(uint256 indexed vaultId, address indexed caller, uint256 amount);

    constructor(uint256 baseClaimFee_, address feeRecipient_)
        EIP712("DeadMansHandV2", "2")
    {
        if (feeRecipient_ == address(0)) revert InvalidDestination();
        if (baseClaimFee_ > MAX_BASE_CLAIM_FEE) revert InvalidBaseClaimFee();
        baseClaimFee = baseClaimFee_;
        feeRecipient = feeRecipient_;
    }

    /// @notice Creates the owner's sole live vault using two public signers and a public KDF salt.
    function createVault(
        address signerA,
        address signerB,
        bytes32 vaultSalt,
        uint64 inactivityPeriod
    ) external returns (uint256 vaultId) {
        if (
            signerA == address(0) || signerB == address(0) || signerA == signerB
                || signerA == msg.sender || signerB == msg.sender
        ) revert InvalidSigners();
        if (vaultSalt == bytes32(0)) revert InvalidVaultSalt();
        if (inactivityPeriod < MIN_INACTIVITY_PERIOD || inactivityPeriod > MAX_INACTIVITY_PERIOD) {
            revert InvalidPeriod();
        }

        uint256 currentLiveVault = liveVaultOf[msg.sender];
        if (
            currentLiveVault != 0
                && _vaults[currentLiveVault].state != VaultState.DEACTIVATED
        ) revert LiveVaultAlreadyExists();

        vaultId = ++vaultCount;
        Vault storage vault = _vaults[vaultId];
        vault.owner = msg.sender;
        vault.signerA = signerA;
        vault.signerB = signerB;
        vault.vaultSalt = vaultSalt;
        vault.lastPing = uint64(block.timestamp);
        vault.inactivityPeriod = inactivityPeriod;
        vault.state = VaultState.ACTIVE;

        _ownerVaults[msg.sender].push(vaultId);
        liveVaultOf[msg.sender] = vaultId;

        emit VaultCreated(
            vaultId,
            msg.sender,
            signerA,
            signerB,
            vaultSalt,
            inactivityPeriod
        );
    }

    /// @notice Registers a token contract. This does not grant an allowance or move assets.
    function addToken(uint256 vaultId, address token, TokenType tokenType) external {
        Vault storage vault = _activeOwnerVault(vaultId);
        if (token == address(0) || token.code.length == 0) revert InvalidToken();
        if (_tokenRegistered[vaultId][token]) revert DuplicateToken();
        if (vault.tokens.length >= MAX_TOKENS) revert TooManyTokens();

        vault.tokens.push(TokenEntry({token: token, tokenType: tokenType}));
        _tokenRegistered[vaultId][token] = true;
        emit TokenAdded(vaultId, token, tokenType);
    }

    /// @notice Removes a registered token while a vault is active.
    function removeToken(uint256 vaultId, address token) external {
        Vault storage vault = _activeOwnerVault(vaultId);
        if (!_tokenRegistered[vaultId][token]) revert TokenNotRegistered();

        uint256 length = vault.tokens.length;
        for (uint256 i; i < length; ++i) {
            if (vault.tokens[i].token == token) {
                vault.tokens[i] = vault.tokens[length - 1];
                vault.tokens.pop();
                _tokenRegistered[vaultId][token] = false;
                emit TokenRemoved(vaultId, token);
                return;
            }
        }

        revert TokenNotRegistered();
    }

    /// @notice Resets an active vault's inactivity timer. Only its owner may call.
    function ping(uint256 vaultId) external {
        Vault storage vault = _activeOwnerVault(vaultId);
        vault.lastPing = uint64(block.timestamp);
        emit Pinged(vaultId, vault.lastPing);
    }

    /// @notice Permanently disables future claims. Token approvals must be revoked separately.
    function deactivateVault(uint256 vaultId) external {
        Vault storage vault = _existingVault(vaultId);
        if (msg.sender != vault.owner) revert NotOwner();
        if (vault.state == VaultState.DEACTIVATED) revert VaultIsDeactivated();

        vault.state = VaultState.DEACTIVATED;
        if (liveVaultOf[msg.sender] == vaultId) liveVaultOf[msg.sender] = 0;
        emit VaultDeactivated(vaultId);
    }

    /// @notice Attempts a claim using signatures from both registered signers.
    /// @dev Invalid signatures deliberately return rather than revert so the fee is consumed.
    function attemptClaim(
        uint256 vaultId,
        address destination,
        bytes calldata sigA,
        bytes calldata sigB
    ) external payable nonReentrant {
        Vault storage vault = _existingVault(vaultId);
        if (vault.state == VaultState.DEACTIVATED) revert VaultIsDeactivated();
        if (block.timestamp < uint256(vault.lastPing) + vault.inactivityPeriod) {
            revert VaultNotYetClaimable();
        }
        if (block.timestamp < callerCooldownUntil[vaultId][msg.sender]) revert CallerInCooldown();
        if (destination == address(0)) revert InvalidDestination();

        uint256 fee = currentClaimFee(vaultId, msg.sender);
        if (msg.value != fee) revert IncorrectFee();

        if (!_signaturesValid(vaultId, destination, vault, sigA, sigB)) {
            // Recognize only the immediately preceding nonce as a legitimate race.
            if (
                vault.nonce > 0
                    && block.timestamp
                        <= uint256(_lastSuccessfulClaimAt[vaultId]) + STALE_SIGNATURE_GRACE_PERIOD
                    && _signaturesValidForNonce(
                        vaultId,
                        destination,
                        vault.signerA,
                        vault.signerB,
                        vault.nonce - 1,
                        sigA,
                        sigB
                    )
            ) revert StaleClaimSignatures();

            uint32 failures = callerFailedAttempts[vaultId][msg.sender];
            if (failures < type(uint32).max) {
                callerFailedAttempts[vaultId][msg.sender] = failures + 1;
            }
            callerCooldownUntil[vaultId][msg.sender] = uint64(block.timestamp + COOLDOWN_DURATION);
            _forwardFee(vaultId, msg.sender, fee);
            emit ClaimFailed(vaultId, msg.sender);
            return;
        }

        ++vault.nonce;
        vault.state = VaultState.CLAIMED;
        _lastSuccessfulClaimAt[vaultId] = uint64(block.timestamp);
        callerFailedAttempts[vaultId][msg.sender] = 0;
        callerCooldownUntil[vaultId][msg.sender] = 0;

        _forwardFee(vaultId, msg.sender, fee);
        _sweep(vaultId, vault, destination);
        emit ClaimExecuted(vaultId, destination, msg.sender);
    }

    /// @notice Returns the fee required from a particular claim submitter.
    function currentClaimFee(uint256 vaultId, address caller) public view returns (uint256) {
        _requireVaultExists(vaultId);
        uint32 failures = callerFailedAttempts[vaultId][caller];
        uint32 doublings = failures > MAX_FEE_DOUBLINGS ? MAX_FEE_DOUBLINGS : failures;
        return baseClaimFee << doublings;
    }

    /// @notice Returns true when a non-deactivated vault has reached its inactivity deadline.
    function isClaimable(uint256 vaultId) public view returns (bool) {
        Vault storage vault = _existingVault(vaultId);
        return vault.state != VaultState.DEACTIVATED
            && block.timestamp >= uint256(vault.lastPing) + vault.inactivityPeriod;
    }

    /// @notice Returns seconds until claimability, or zero once mature.
    function remainingTime(uint256 vaultId) external view returns (uint256) {
        Vault storage vault = _existingVault(vaultId);
        uint256 deadline = uint256(vault.lastPing) + vault.inactivityPeriod;
        return block.timestamp >= deadline ? 0 : deadline - block.timestamp;
    }

    /// @notice Returns vault metadata without its dynamic token registry.
    function getVault(uint256 vaultId) external view returns (VaultView memory) {
        Vault storage vault = _existingVault(vaultId);
        return VaultView({
            owner: vault.owner,
            signerA: vault.signerA,
            signerB: vault.signerB,
            vaultSalt: vault.vaultSalt,
            lastPing: vault.lastPing,
            inactivityPeriod: vault.inactivityPeriod,
            nonce: vault.nonce,
            state: vault.state
        });
    }

    /// @notice Returns every token registered to a vault.
    function getVaultTokens(uint256 vaultId) external view returns (TokenEntry[] memory) {
        return _existingVault(vaultId).tokens;
    }

    /// @notice Returns all historical vault IDs created by an owner.
    function vaultsOf(address owner) external view returns (uint256[] memory) {
        return _ownerVaults[owner];
    }

    function _sweep(uint256 vaultId, Vault storage vault, address destination) private {
        uint256 nftTransfers;
        uint256 length = vault.tokens.length;

        for (uint256 i; i < length; ++i) {
            TokenEntry storage entry = vault.tokens[i];
            if (entry.tokenType == TokenType.ERC20) {
                _sweepERC20(vaultId, entry.token, vault.owner, destination);
                continue;
            }

            if (nftTransfers >= MAX_NFT_TRANSFERS_PER_CLAIM) {
                emit TokenSkipped(vaultId, entry.token, REASON_NFT_LIMIT_REACHED);
                continue;
            }
            nftTransfers = _sweepERC721(
                vaultId,
                entry.token,
                vault.owner,
                destination,
                nftTransfers
            );
        }

        if (nftTransfers >= MAX_NFT_TRANSFERS_PER_CLAIM) emit SweepLimitReached(vaultId);
    }

    function _signaturesValid(
        uint256 vaultId,
        address destination,
        Vault storage vault,
        bytes calldata sigA,
        bytes calldata sigB
    ) private view returns (bool) {
        return _signaturesValidForNonce(
            vaultId, destination, vault.signerA, vault.signerB, vault.nonce, sigA, sigB
        );
    }

    function _signaturesValidForNonce(
        uint256 vaultId,
        address destination,
        address signerA,
        address signerB,
        uint256 nonce,
        bytes calldata sigA,
        bytes calldata sigB
    ) private view returns (bool) {
        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, vaultId, destination, nonce)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        (address recoveredA, ECDSA.RecoverError errorA,) = ECDSA.tryRecover(digest, sigA);
        (address recoveredB, ECDSA.RecoverError errorB,) = ECDSA.tryRecover(digest, sigB);
        return errorA == ECDSA.RecoverError.NoError && recoveredA == signerA
            && errorB == ECDSA.RecoverError.NoError && recoveredB == signerB;
    }

    function _sweepERC20(
        uint256 vaultId,
        address token,
        address owner,
        address destination
    ) private {
        (bool balanceOk, uint256 balance) = _readUint(
            token,
            abi.encodeWithSelector(bytes4(keccak256("balanceOf(address)")), owner)
        );
        if (!balanceOk) {
            emit TokenSkipped(vaultId, token, REASON_BALANCE_READ_FAILED);
            return;
        }

        (bool allowanceOk, uint256 allowance) = _readUint(
            token,
            abi.encodeWithSelector(
                bytes4(keccak256("allowance(address,address)")), owner, address(this)
            )
        );
        if (!allowanceOk) {
            emit TokenSkipped(vaultId, token, REASON_ALLOWANCE_READ_FAILED);
            return;
        }

        uint256 amount = balance < allowance ? balance : allowance;
        if (amount == 0) return;

        (bool success,) = token.call{gas: TRANSFER_CALL_GAS}(
            abi.encodeWithSelector(
                bytes4(keccak256("transferFrom(address,address,uint256)")),
                owner,
                destination,
                amount
            )
        );
        if (!success || !_optionalBooleanSucceeded()) {
            emit TokenSkipped(vaultId, token, REASON_TRANSFER_FAILED);
            return;
        }

        emit ERC20Swept(vaultId, token, destination, amount);
    }

    function _sweepERC721(
        uint256 vaultId,
        address token,
        address owner,
        address destination,
        uint256 transferred
    ) private returns (uint256) {
        (bool enumerableOk, bool enumerable) = _readBool(
            token,
            abi.encodeWithSelector(
                bytes4(keccak256("supportsInterface(bytes4)")),
                ERC721_ENUMERABLE_INTERFACE_ID
            )
        );
        if (!enumerableOk || !enumerable) {
            emit TokenSkipped(vaultId, token, REASON_NOT_ENUMERABLE);
            return transferred;
        }

        (bool balanceOk, uint256 balance) = _readUint(
            token,
            abi.encodeWithSelector(bytes4(keccak256("balanceOf(address)")), owner)
        );
        if (!balanceOk) {
            emit TokenSkipped(vaultId, token, REASON_BALANCE_READ_FAILED);
            return transferred;
        }

        while (balance > 0 && transferred < MAX_NFT_TRANSFERS_PER_CLAIM) {
            (bool tokenIdOk, uint256 tokenId) = _readUint(
                token,
                abi.encodeWithSelector(
                    bytes4(keccak256("tokenOfOwnerByIndex(address,uint256)")), owner, 0
                )
            );
            if (!tokenIdOk) {
                emit TokenSkipped(vaultId, token, REASON_ENUMERATION_FAILED);
                return transferred;
            }

            (bool success,) = token.call{gas: TRANSFER_CALL_GAS}(
                abi.encodeWithSelector(
                    bytes4(keccak256("safeTransferFrom(address,address,uint256)")),
                    owner,
                    destination,
                    tokenId
                )
            );
            if (!success) {
                emit TokenSkipped(vaultId, token, REASON_TRANSFER_FAILED);
                return transferred;
            }

            emit ERC721Swept(vaultId, token, destination, tokenId);
            ++transferred;
            --balance;
        }

        if (balance > 0) emit TokenSkipped(vaultId, token, REASON_NFT_LIMIT_REACHED);
        return transferred;
    }

    function _readUint(address target, bytes memory data) private view returns (bool, uint256 value) {
        (bool success,) = target.staticcall{gas: READ_CALL_GAS}(data);
        if (!success || _returndataSize() < 32) return (false, 0);
        assembly ("memory-safe") {
            returndatacopy(0, 0, 32)
            value := mload(0)
        }
        return (true, value);
    }

    function _readBool(address target, bytes memory data) private view returns (bool, bool) {
        (bool success,) = target.staticcall{gas: READ_CALL_GAS}(data);
        if (!success || _returndataSize() < 32) return (false, false);
        uint256 value;
        assembly ("memory-safe") {
            returndatacopy(0, 0, 32)
            value := mload(0)
        }
        if (value > 1) return (false, false);
        return (true, value == 1);
    }

    function _optionalBooleanSucceeded() private pure returns (bool succeeded) {
        uint256 size = _returndataSize();
        if (size == 0) return true;
        if (size < 32) return false;
        uint256 value;
        assembly ("memory-safe") {
            returndatacopy(0, 0, 32)
            value := mload(0)
        }
        return value == 1;
    }

    function _returndataSize() private pure returns (uint256 size) {
        assembly ("memory-safe") {
            size := returndatasize()
        }
    }

    function _forwardFee(uint256 vaultId, address caller, uint256 fee) private {
        if (fee == 0) {
            emit FeeForwarded(vaultId, caller, 0);
            return;
        }
        (bool sent,) = feeRecipient.call{value: fee}("");
        if (!sent) revert FeeForwardFailed();
        emit FeeForwarded(vaultId, caller, fee);
    }

    function _activeOwnerVault(uint256 vaultId) private view returns (Vault storage vault) {
        vault = _existingVault(vaultId);
        if (msg.sender != vault.owner) revert NotOwner();
        if (vault.state != VaultState.ACTIVE) revert VaultNotActive();
    }

    function _existingVault(uint256 vaultId) private view returns (Vault storage vault) {
        _requireVaultExists(vaultId);
        return _vaults[vaultId];
    }

    function _requireVaultExists(uint256 vaultId) private view {
        if (vaultId == 0 || vaultId > vaultCount || _vaults[vaultId].owner == address(0)) {
            revert VaultNotFound();
        }
    }
}
