import { Conflux, Drip, format, address } from 'js-conflux-sdk';
import Web3 from 'web3';

export class ESpaceFunding {
  private coreRpc: string;
  private corePk: string;
  private fundAmount: string;

  constructor() {
    this.coreRpc = process.env.CORE_RPC_URL || 'http://conflux:12537';
    this.corePk = process.env.CORE_PK || '';
    this.fundAmount = process.env.ESPACE_FUND_AMOUNT_CFX || '1.0';
  }

  async fundESpaceAccount(agentAddress: string): Promise<void> {
    const coreRpcUrl = process.env.CORE_RPC_URL;
    const corePk = process.env.CORE_PK;
    const fundAmountCfx = parseFloat(process.env.ESPACE_FUND_AMOUNT_CFX || '0.1');

    if (!coreRpcUrl || !corePk) {
      throw new Error('CORE_RPC_URL and CORE_PK environment variables are required');
    }

    if (fundAmountCfx <= 0) {
      throw new Error('ESPACE_FUND_AMOUNT_CFX must be greater than 0');
    }

    // Initialize Conflux SDK for Core Space
    const conflux = new Conflux({
      url: coreRpcUrl,
      networkId: parseInt(process.env.CORE_NETWORK_ID || '1'),
      logger: console
    });

    // Add the funding account
    const fundingAccount = conflux.wallet.addPrivateKey(corePk);
    console.log(`Funding account: ${fundingAccount.address}`);

    // Check if eSpace account already has sufficient balance
    const web3 = new Web3(process.env.ESPACE_RPC_URL || 'https://evm.confluxrpc.com');
    const currentBalance = await web3.eth.getBalance(agentAddress);
    const currentBalanceEth = parseFloat(web3.utils.fromWei(currentBalance, 'ether'));

    if (currentBalanceEth >= fundAmountCfx) {
      console.log(`Agent ${agentAddress} already has sufficient balance: ${currentBalanceEth} CFX`);
      return;
    }

    console.log(`Funding agent ${agentAddress} with ${fundAmountCfx} CFX...`);

    // Convert hex address to CIP-37 base32 format for eSpace
    const base32Address = address.encodeCfxAddress(agentAddress, conflux.networkId);
    console.log(`Converted address to base32: ${base32Address}`);
    
    // Get the CrossSpaceCall internal contract
    const crossSpaceCall = conflux.InternalContract('CrossSpaceCall');

    try {
      // Send the cross-space transfer transaction
      const receipt = await crossSpaceCall.transferEVM(agentAddress)
        .sendTransaction({
          from: fundingAccount,
          value: Drip.fromCFX(fundAmountCfx)
        }).executed();
      
      console.log(`Transfer transaction executed in block ${receipt.blockNumber}`);
      console.log(`Transaction outcome: ${receipt.outcomeStatus === 0 ? 'success' : 'failed'}`);

      // Wait for balance to reflect in eSpace (up to 30 seconds)
      let attempts = 0;
      const maxAttempts = 30;
      
      while (attempts < maxAttempts) {
        const newBalance = await web3.eth.getBalance(agentAddress);
        const newBalanceEth = parseFloat(web3.utils.fromWei(newBalance, 'ether'));
        
        if (newBalanceEth >= fundAmountCfx) {
          console.log(`eSpace balance updated: ${newBalanceEth} CFX`);
          return;
        }
        
        console.log(`Waiting for eSpace balance update... (${attempts + 1}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
      }

      throw new Error('eSpace balance did not update within expected time');
    } catch (error) {
      console.error('Failed to fund eSpace account:', error);
      throw error;
    }
  }
}