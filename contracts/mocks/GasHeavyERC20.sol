// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only ERC20 that consumes most of DMH's per-call gas stipends before succeeding.
contract GasHeavyERC20 {
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        uint256 balance = _balances[account];
        _burnGasToReserve(2_500);
        return balance;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        uint256 approved = _allowances[owner][spender];
        _burnGasToReserve(2_500);
        return approved;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = _allowances[from][msg.sender];
        require(approved >= amount && _balances[from] >= amount, "insufficient");
        // The 50k reserve covers three storage writes and ABI return overhead.
        _burnGasToReserve(50_000);
        _allowances[from][msg.sender] = approved - amount;
        _balances[from] -= amount;
        _balances[to] += amount;
        return true;
    }

    function _burnGasToReserve(uint256 reserve) private view returns (uint256 noise) {
        assembly ("memory-safe") {
            for { } gt(gas(), reserve) { } {
                mstore(0, add(mload(0), gas()))
                noise := keccak256(0, 32)
            }
        }
        require(noise != type(uint256).max, "unreachable");
    }
}
