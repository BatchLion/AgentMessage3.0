import { Web3 } from 'web3';
import * as fs from 'fs-extra';
import { ContractEntry } from './types';

export class IdentityContract {
  private web3: Web3;
  private contract: any;

  constructor(rpcUrl: string, contractAddressOrFile: string, abiPath: string = 'IdentityRegistry.json') {
    this.web3 = new Web3(rpcUrl);
    
    // Read contract address from file if it's a file path
    let contractAddress: string;
    if (contractAddressOrFile.includes('/') || contractAddressOrFile.includes('\\')) {
      // It's a file path
      contractAddress = fs.readFileSync(contractAddressOrFile, 'utf8').trim();
    } else {
      // It's a direct address
      contractAddress = contractAddressOrFile;
    }
    
    const artifact = fs.readJsonSync(abiPath);
    const abi = artifact.abi || artifact;
    
    this.contract = new this.web3.eth.Contract(abi, contractAddress);
  }

  async getBalance(address: string): Promise<bigint> {
    return await this.web3.eth.getBalance(address);
  }

  private getRawTxBytes(signed: any): string {
    // Handle different versions of eth-account
    return signed.rawTransaction || signed.raw_transaction || signed['rawTransaction'];
  }

  async register(agentId: string, metadata: string, privateKey: string): Promise<string> {
    if (!privateKey) {
      throw new Error('private_key is required to sign the transaction');
    }

    const account = this.web3.eth.accounts.privateKeyToAccount(privateKey);
    const chainId = await this.web3.eth.getChainId();
    const latestBlock = await this.web3.eth.getBlock('latest');
    
    // Check if EIP-1559 is supported
    const eip1559Supported = latestBlock && 'baseFeePerGas' in latestBlock;
    
    const nonce = await this.web3.eth.getTransactionCount(account.address);
    
    const common = {
      from: account.address,
      nonce: nonce,
      gas: 1000000,
      chainId: chainId,
    };

    let tx: any;

    if (eip1559Supported) {
      try {
        // Use eth_feeHistory to estimate fees
        const feeHistory = await this.web3.eth.getFeeHistory(10, 'latest', [50]);
        const rewards = feeHistory.reward?.map((r: any) => r[0]).filter((r: any) => r) || [];
        
        let tip = rewards.length > 0 
          ? BigInt(rewards.sort((a: any, b: any) => Number(a) - Number(b))[Math.floor(rewards.length / 2)])
          : BigInt(this.web3.utils.toWei('2', 'gwei'));
        
        const baseFees = feeHistory.baseFeePerGas || [];
        const nextBase = baseFees.length > 0 
          ? BigInt(baseFees[baseFees.length - 1])
          : BigInt(latestBlock.baseFeePerGas || 0);
        
        // Enforce minimum tip
        if (tip < BigInt(this.web3.utils.toWei('1', 'gwei'))) {
          tip = BigInt(this.web3.utils.toWei('1', 'gwei'));
        }
        
        // Robust cap: 2x next base fee + median tip
        const maxFee = nextBase * 2n + tip;
        
        tx = {
          ...common,
          maxPriorityFeePerGas: tip.toString(),
          maxFeePerGas: maxFee.toString(),
          type: 2,
          data: this.contract.methods.register(agentId, metadata).encodeABI(),
          to: this.contract.options.address,
        };
      } catch (error) {
        // Fallback to simple heuristic
        const baseFee = BigInt(latestBlock.baseFeePerGas || 0);
        const tip = BigInt(this.web3.utils.toWei('2', 'gwei'));
        const maxFee = baseFee * 2n + tip;
        
        tx = {
          ...common,
          maxPriorityFeePerGas: tip.toString(),
          maxFeePerGas: maxFee.toString(),
          type: 2,
          data: this.contract.methods.register(agentId, metadata).encodeABI(),
          to: this.contract.options.address,
        };
      }
    } else {
      const gasPrice = await this.web3.eth.getGasPrice();
      tx = {
        ...common,
        gasPrice: gasPrice.toString(),
        data: this.contract.methods.register(agentId, metadata).encodeABI(),
        to: this.contract.options.address,
      };
    }

    const signed = await account.signTransaction(tx);
    const receipt = await this.web3.eth.sendSignedTransaction(signed.rawTransaction as string);
    
    return (receipt as any).transactionHash;
  }

  async getEntry(address: string): Promise<any> {
    return await this.contract.methods.getEntry(address).call();
  }

  async getAllEntries(fromBlock: number = 0, toBlock: string | number = 'latest'): Promise<ContractEntry[]> {
    // Scan Registered events to discover all owners
    const topic0 = this.web3.utils.keccak256('Registered(address,string,string,uint256)');
    
    const logs = await this.web3.eth.getPastLogs({
      address: this.contract.options.address,
      fromBlock: fromBlock,
      toBlock: toBlock,
      topics: [topic0],
    });

    const ownersSet = new Set<string>();
    const owners: string[] = [];

    for (const log of logs) {
      // owner is the first indexed topic (topics[1])
      if (typeof log !== 'string' && log.topics && log.topics.length > 1) {
        const t1 = log.topics[1];
        const owner = this.web3.utils.toChecksumAddress('0x' + t1.slice(-40));
        const ownerLower = owner.toLowerCase();
        
        if (!ownersSet.has(ownerLower)) {
          ownersSet.add(ownerLower);
          owners.push(owner);
        }
      }
    }

    const entries: ContractEntry[] = [];
    
    for (const owner of owners) {
      try {
        const entry = await this.contract.methods.getEntry(owner).call();
        entries.push({
          owner: entry[0],
          agentId: entry[1],
          metadata: entry[2],
          updatedAt: entry[3],
        });
      } catch (error) {
        // Skip failed entries
        continue;
      }
    }

    return entries;
  }
}