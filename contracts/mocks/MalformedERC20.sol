// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MalformedERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        assembly ("memory-safe") {
            mstore(0, 2)
            return(0, 32)
        }
    }
}
