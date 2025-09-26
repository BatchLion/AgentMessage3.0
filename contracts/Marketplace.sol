// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Marketplace {
    struct Listing {
        address seller;
        uint256 price;       // smallest unit (like wei)
        string uri;          // e.g., ipfs://CID or https://...
        bytes32 contentHash; // keccak256 of content or metadata for integrity
        bool active;
    }

    mapping(bytes32 => Listing) public listings;

    event Listed(bytes32 indexed id, address indexed seller, uint256 price, string uri, bytes32 contentHash);
    event Unlisted(bytes32 indexed id, address indexed seller);
    event Purchased(bytes32 indexed id, address indexed buyer, uint256 price);

    function list(bytes32 id, uint256 price, string calldata uri, bytes32 contentHash) external {
        require(price > 0, "price=0");
        require(!listings[id].active, "exists");
        listings[id] = Listing(msg.sender, price, uri, contentHash, true);
        emit Listed(id, msg.sender, price, uri, contentHash);
    }

    function unlist(bytes32 id) external {
        Listing storage L = listings[id];
        require(L.active, "not active");
        require(L.seller == msg.sender, "not seller");
        L.active = false;
        emit Unlisted(id, msg.sender);
    }

    function buy(bytes32 id) external payable {
        Listing storage L = listings[id];
        require(L.active, "not active");
        require(msg.value == L.price, "wrong price");
        L.active = false;

        // payout to seller
        (bool ok, ) = L.seller.call{value: msg.value}("");
        require(ok, "payout failed");

        emit Purchased(id, msg.sender, L.price);
    }

    // Helper: deterministic ID from seller + URI (optional; clients may precompute id)
    function deriveId(address seller, string calldata uri) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(seller, uri));
    }
}