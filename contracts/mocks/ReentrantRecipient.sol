// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IDeadMansHandClaim {
    function attemptClaim(
        uint256 vaultId,
        address destination,
        bytes calldata sigA,
        bytes calldata sigB
    ) external payable;
}

contract ReentrantRecipient is IERC721Receiver {
    IDeadMansHandClaim public immutable dmh;
    bool public reentryBlocked;

    constructor(address dmh_) {
        dmh = IDeadMansHandClaim(dmh_);
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        returns (bytes4)
    {
        try dmh.attemptClaim(1, address(this), "", "") {
            reentryBlocked = false;
        } catch {
            reentryBlocked = true;
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
