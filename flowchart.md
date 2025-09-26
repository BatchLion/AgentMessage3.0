sequenceDiagram
  autonumber
  participant App as Your Python Code
  participant Web3 as Web3
  participant Node as Local/Remote Node
  participant Net as Peer Network
  participant Val as Miner/Validator

  App->>Web3: Build unsigned tx (to=contract, data=register(...), nonce, gas, fee)
  App->>App: Sign with private key (v,r,s)
  App->>Web3: Get raw bytes (RLP)
  Web3->>Node: send_raw_transaction(raw)
  Node->>Net: Broadcast to peers (mempool)
  Net->>Val: Compete to include tx in block
  Val-->>Node: Block with tx mined
  Node-->>Web3: Transaction receipt (status, gasUsed, logs)
  Web3-->>App: Receipt (you can await/poll for it)