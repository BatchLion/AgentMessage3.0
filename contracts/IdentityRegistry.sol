// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract IdentityRegistry {
    struct Entry {
        address owner;
        string agentId;
        string metadata;
        uint256 updatedAt;
    }

    mapping(address => Entry) public entries;

    event Registered(address indexed owner, string agentId, string metadata, uint256 updatedAt);

    function register(string calldata agentId, string calldata metadata) external {
        entries[msg.sender] = Entry({
            owner: msg.sender,
            agentId: agentId,
            metadata: metadata,
            updatedAt: block.timestamp
        });
        emit Registered(msg.sender, agentId, metadata, block.timestamp);
    }

    function getEntry(address who) external view returns (Entry memory) {
        return entries[who];
    }
}