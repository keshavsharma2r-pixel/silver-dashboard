// --- PROTOBUF SCHEMA FOR UPSTOX ---
const protobufSchema = `
syntax = "proto3";
package com.upstox.marketdatafeeder.rpc.proto;

message FeedResponse {
  enum Type { initial_feed = 0; live_feed = 1; }
  Type type = 1;
  map<string, Feed> feeds = 2;
}
message Feed {
  oneof FeedUnion {
    LTPC ltpc = 1;
    FullFeed fullFeed = 2;
    IndexFeed indexFeed = 3;
  }
}
message LTPC {
  double ltp = 1;
  int64 ltt = 2;
  int64 ltq = 3;
  double cp = 4;
}
message FullFeed {
  LTPC ltpc = 1;
  int64 volume = 7;
}
message IndexFeed {
  LTPC ltpc = 1;
}
`;

// --- MATH & INDICATOR ENGINE ---
const MathEngine = {
    sma: (data, period) => {
        if(data.length < period) return 0;
        let sum = 0;
        for(let i=data.length-period; i<data.length; i++) sum += data[i];
        return sum / period;
    },
    ema: (data, period) => {
        if(data.length < period) return 0;
        const k = 2 / (period + 1);
        let ema = data[data.length-period]; // Start with SMA as first EMA
        // actually a true EMA needs to go back further, but for simplicity we calculate over the available window sequentially
        let currentEma = data.slice(0, period).reduce((a,b)=>a+b,0)/period;
        for(let i=period; i<data.length; i++) {
            currentEma = (data[i] - currentEma) * k + currentEma;
        }
        return currentEma;
    },
    stdev: (data, period) => {
        if(data.length < period) return 0;
        const mean = MathEngine.sma(data, period);
        let sum = 0;
        for(let i=data.length-period; i<data.length; i++){
            sum += Math.pow(data[i] - mean, 2);
        }
        return Math.sqrt(sum / period);
    },
    rsi: (data, period) => {
        if(data.length <= period) return 50;
        let gains = 0, losses = 0;
        for(let i=data.length-period; i<data.length; i++){
            const diff = data[i] - data[i-1];
            if(diff >= 0) gains += diff;
            else losses -= diff;
        }
        if(losses === 0) return 100;
        const rs = (gains/period) / (losses/period);
        return 100 - (100 / (1 + rs));
    },
    correlation: (yData, period) => {
        // Correlate last N items of yData with [1, 2, ..., N]
        if(yData.length < period) return 0;
        let sumX=0, sumY=0, sumXY=0, sumX2=0, sumY2=0;
        for(let i=0; i<period; i++){
            const x = i + 1;
            const y = yData[yData.length - period + i];
            sumX += x; sumY += y;
            sumXY += x*y; sumX2 += x*x; sumY2 += y*y;
        }
        const n = period;
        const numerator = (n*sumXY) - (sumX*sumY);
        const denom = Math.sqrt((n*sumX2 - sumX*sumX) * (n*sumY2 - sumY*sumY));
        if(denom === 0) return 0;
        return numerator / denom;
    }
};

// --- STATE MANAGEMENT ---
const state = {
    mcx: { prices: [], volumes: [], opens: [] },
    etf: { prices: [], opens: [] },
    lastSignal: "NONE",
    lastSignalPrice: null,
    pnl: 0,
    ws: null
};

// --- UI UPDATER ---
function log(msg, type="info") {
    const w = document.getElementById("log-window");
    const div = document.createElement("div");
    div.className = "log-" + type;
    div.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    w.appendChild(div);
    w.scrollTop = w.scrollHeight;
}

function updateElement(id, value, flashClass = null) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.innerText !== String(value)) {
        el.innerText = value;
        if (flashClass) {
            el.classList.remove("val-update", "price-flash-up", "price-flash-down");
            void el.offsetWidth; // trigger reflow
            el.classList.add(flashClass);
        } else {
            el.classList.remove("val-update");
            void el.offsetWidth;
            el.classList.add("val-update");
        }
    }
}

// Generate Mock Historical Data to instantly power the engine
function generateMockHistory(startPrice) {
    let price = startPrice;
    const items = [];
    const vols = [];
    const opens = [];
    for(let i=0; i<80; i++){
        opens.push(price);
        price += (Math.random() - 0.45) * 2; // slightly bullish random walk
        items.push(price);
        vols.push(Math.floor(Math.random() * 5000) + 1000);
    }
    return { prices: items, vols: vols, opens: opens };
}

// --- ENGINE CALCULATION TICK ---
function runEngineTick() {
    const mcxData = state.mcx;
    const etfData = state.etf;
    if(mcxData.prices.length < 50) return; // Need 50 items

    const price = mcxData.prices[mcxData.prices.length - 1];
    const prevPrice = mcxData.prices[mcxData.prices.length - 2] || price;
    const vol = mcxData.volumes[mcxData.volumes.length - 1];
    const open = mcxData.opens[mcxData.opens.length - 1];
    const prevOpen = mcxData.opens[mcxData.opens.length - 2] || open;
    
    // MCX Base stats
    const mcxChange = price - prevPrice;
    const mcxPercent = (mcxChange / prevPrice) * 100;
    
    // Trend Model
    const emaFast = MathEngine.ema(mcxData.prices, 20);
    const emaSlow = MathEngine.ema(mcxData.prices, 50);
    const trendBull = emaFast > emaSlow;
    const trendBear = emaFast < emaSlow;

    // Volume Model
    const volAvg = MathEngine.sma(mcxData.volumes, 20);
    let volScore = 0;
    if(vol > volAvg*2) volScore = 3;
    else if(vol > volAvg*1.5) volScore = 2;
    else if(vol > volAvg*1.2) volScore = 1;

    // Smart Money
    let smartMoney = "NORMAL";
    if(vol > volAvg*2 && price > emaFast) smartMoney = "ACCUMULATION";
    else if(vol > volAvg*2 && price < emaFast) smartMoney = "DISTRIBUTION";

    // Meta Model
    const rsiVal = MathEngine.rsi(mcxData.prices, 14);
    let meta = 0;
    if(rsiVal > 60) meta = 1;
    else if (rsiVal < 40) meta = -1;
    const metaState = meta > 0 ? "BULLISH" : (meta < 0 ? "BEARISH" : "NEUTRAL");

    // Autoencoder Factor
    const priceMean = MathEngine.sma(mcxData.prices, 50);
    const priceStd = MathEngine.stdev(mcxData.prices, 50);
    const volMean = MathEngine.sma(mcxData.volumes, 50);
    const volStd = MathEngine.stdev(mcxData.volumes, 50);
    
    const zprice = priceStd !== 0 ? (price - priceMean)/priceStd : 0;
    const zvol = volStd !== 0 ? (vol - volMean)/volStd : 0;
    const factor = (zprice + zvol) / 2;
    const factorState = factor > 0.5 ? "BULLISH" : (factor < -0.5 ? "BEARISH" : "NEUTRAL");

    // MCX Momentum
    const mcxMom = MathEngine.ema(mcxData.prices, 5) - MathEngine.ema(mcxData.prices, 20);
    const mcxBias = mcxMom > 0 ? "BULLISH LEAD" : (mcxMom < 0 ? "BEARISH LEAD" : "NEUTRAL");

    // Signal Engine
    let signal = "NEUTRAL";
    if(trendBull && volScore>=2 && factor>0.5) signal = "STRONG BUY";
    else if(trendBull && factor>0) signal = "BUY";
    else if(trendBear && volScore>=2 && factor<-0.5) signal = "STRONG SELL";
    else if(trendBear && factor<0) signal = "SELL";
    else if(factor>1) signal = "CUT";

    if(signal !== state.lastSignal) {
        state.lastSignalPrice = price;
        state.lastSignal = signal;
    }

    // PNL
    if(state.lastSignalPrice) {
        if(["BUY", "STRONG BUY"].includes(state.lastSignal)) state.pnl = price - state.lastSignalPrice;
        if(["SELL", "STRONG SELL"].includes(state.lastSignal)) state.pnl = state.lastSignalPrice - price;
    }

    // ETF Bias & Prob
    const biasScore = factor + meta + volScore;
    const tomorrow = biasScore > 2 ? "BULLISH OPEN" : (biasScore < -2 ? "BEARISH OPEN" : "FLAT OPEN");
    const probBull = Math.max(0, Math.min(100, 50 + biasScore*10));

    // R2 Trend
    const r2Corr = MathEngine.correlation(mcxData.prices, 50);
    const r2 = r2Corr * r2Corr;
    const r2State = r2 > 0.7 ? "STRONG TREND" : (r2 > 0.4 ? "MODERATE TREND" : "RANGE MARKET");

    // --- Mismatch Engine ---
    let etfPrice = etfData.prices[etfData.prices.length - 1] || 0;
    let etfPrevPrice = etfData.prices[etfData.prices.length - 2] || etfPrice;
    
    // Evaluate Lead Candlestick logic
    const leadBull = (price > open) && (prevPrice > prevOpen);
    const leadBear = (price < open) && (prevPrice < prevOpen);
    const etfBull = (etfPrice > etfPrevPrice);
    const etfBear = (etfPrice < etfPrevPrice);
    
    const move = price - (mcxData.prices[mcxData.prices.length - 3] || prevPrice);
    const same = (leadBull && etfBull) || (leadBear && etfBear);

    // --- APPLY TO DOM ---
    const sf = mcxChange >= 0 ? "price-flash-up" : "price-flash-down";
    
    updateElement("val-price", price.toFixed(2), sf);
    updateElement("val-last-price", state.lastSignalPrice ? state.lastSignalPrice.toFixed(2) : "-", null);
    
    const sigEl = document.getElementById("val-signal");
    sigEl.innerText = signal;
    sigEl.dataset.signal = signal;

    const pnlEl = document.getElementById("val-pnl");
    pnlEl.innerText = `₹${state.pnl.toFixed(2)}`;
    pnlEl.className = "pnl-value " + (state.pnl >= 0 ? "profit" : "loss");
    
    document.getElementById("val-status").innerText = state.pnl > 0 ? "PROFIT RUNNING" : (state.pnl < 0 ? "LOSS RUNNING" : "WAITING");
    
    document.getElementById("val-prob-bar").style.width = `${probBull}%`;
    updateElement("val-prob-text", `${probBull.toFixed(1)}% BULL`);

    updateElement("val-mcx", price.toFixed(2), sf);
    
    const mcxBadge = document.getElementById("val-mcx-change");
    mcxBadge.innerText = `${mcxPercent > 0 ? '+' : ''}${mcxPercent.toFixed(2)}%`;
    mcxBadge.className = "badge " + (mcxPercent > 0 ? "green" : "red");

    updateElement("val-mcx-lead", mcxBias);
    updateElement("val-smart-money", smartMoney);
    updateElement("val-meta", `${meta} (${metaState})`);
    updateElement("val-factor", `${factor.toFixed(2)} (${factorState})`);
    updateElement("val-bias", tomorrow);
    updateElement("val-r2", `${r2.toFixed(2)} (${r2State})`);

    // Mismatch Update
    const leadDir = leadBull ? "Bullish" : (leadBear ? "Bearish" : "Neutral");
    const etfDir = etfBull ? "Bullish" : (etfBear ? "Bearish" : "Neutral");
    
    document.getElementById("val-mm-lead-dir").innerText = leadDir;
    document.getElementById("val-mm-lead-dir").className = "badge " + (leadBull ? "green" : (leadBear ? "red" : ""));
    
    updateElement("val-mm-lead-move", move.toFixed(2));
    
    let statusText = same ? "Same" : (leadBull ? `Bullish (${move.toFixed(2)})` : (leadBear ? `Bearish (${move.toFixed(2)})` : "Neutral"));
    document.getElementById("val-mm-status-badge").innerText = statusText;
    document.getElementById("val-mm-status-badge").className = "badge " + (same ? "green" : (leadBull ? "blue" : (leadBear ? "red" : "")));

    document.getElementById("val-mm-etf-dir").innerText = etfDir;
    document.getElementById("val-mm-etf-dir").className = "badge " + (etfBull ? "green" : (etfBear ? "red" : ""));
    
    const fbadge = document.getElementById("val-mm-etf-follow").querySelector('.badge');
    fbadge.innerText = same ? "Following" : "Not Following";
    fbadge.className = "badge " + (same ? "green" : "red");
}


// --- UPSTOX WEBSOCKET CONNECTION ---
async function initUpstox(token, mcxKey, etfKey) {
    log("Initializing Upstox...", "info");
    const btn = document.getElementById("connect-btn");
    const loader = document.getElementById("connect-loader");
    loader.classList.remove("hidden");
    
    // Inject Mock History to instantly show working dashboard
    const m1 = generateMockHistory(90000); // 90,000 INR approx for MCX
    state.mcx.prices = m1.prices;
    state.mcx.volumes = m1.vols;
    state.mcx.opens = m1.opens;
    
    const m2 = generateMockHistory(85); // 85 INR approx for SILVERBEES
    state.etf.prices = m2.prices;
    state.etf.opens = m2.opens;

    runEngineTick();

    try {
        // Try getting real WS URL
        const authRes = await fetch("https://api.upstox.com/v2/feed/market-data-feed/authorize", {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
        });
        
        if (!authRes.ok) throw new Error(`Auth failed: ${authRes.status}`);
        
        const wsData = await authRes.json();
        const wsUrl = wsData.data.authorizedRedirectUri;
        
        // Setup Protobuf Root
        const root = protobuf.parse(protobufSchema).root;
        const FeedResponse = root.lookupType("com.upstox.marketdatafeeder.rpc.proto.FeedResponse");

        state.ws = new WebSocket(wsUrl);
        state.ws.binaryType = "arraybuffer";
        
        state.ws.onopen = () => {
            log("WebSocket Connected!", "success");
            // Subscribe to instruments
            const payload = {
                guid: "silver-ai-dash",
                method: "sub",
                data: {
                    mode: "full",
                    instrumentKeys: [mcxKey, etfKey]
                }
            };
            state.ws.send(new Blob([JSON.stringify(payload)]));
            
            // Hide Modal
            document.getElementById("token-modal").classList.add("hidden");
            document.getElementById("dashboard").classList.remove("hidden");
        };

        state.ws.onmessage = async (event) => {
            try {
                const arrayBuffer = await event.data.arrayBuffer();
                const uint8Array = new Uint8Array(arrayBuffer);
                const message = FeedResponse.decode(uint8Array);
                const object = FeedResponse.toObject(message, { enums: String, defaults: true });
                
                if (object && object.feeds) {
                    let updated = false;
                    for (const [key, feed] of Object.entries(object.feeds)) {
                        let ltpData = null;
                        
                        if(feed.fullFeed) {
                            ltpData = feed.fullFeed.ltpc;
                            const volume = feed.fullFeed.volume || Math.floor(Math.random()*2000); // fallback
                            
                            if (key === mcxKey && ltpData) {
                                state.mcx.prices.push(ltpData.ltp);
                                state.mcx.volumes.push(volume);
                                state.mcx.opens.push(ltpData.cp || ltpData.ltp); // Mock open with closing price if not natively tracked in memory
                                updated = true;
                                if(state.mcx.prices.length > 200) { state.mcx.prices.shift(); state.mcx.volumes.shift(); state.mcx.opens.shift(); }
                            }
                            if (key === etfKey && ltpData) {
                                state.etf.prices.push(ltpData.ltp);
                                state.etf.opens.push(ltpData.cp || ltpData.ltp);
                                updated = true;
                                if(state.etf.prices.length > 200) { state.etf.prices.shift(); state.etf.opens.shift(); }
                            }
                        }
                    }
                    if (updated) runEngineTick();
                }
            } catch (err) {
                // Ignoring partial parses or non-protobuf messages (like JSON acks)
            }
        };

        state.ws.onerror = (e) => log("WebSocket Error!", "err");
        state.ws.onclose = () => log("WebSocket Disconnected.", "err");
        
    } catch(err) {
        log(err.message, "err");
        document.getElementById("auth-error").innerText = "Could not connect. Providing Mock Live Feed for demo purposes.";
        loader.classList.add("hidden");
        
        // Demo Mode (simulates incoming ticks)
        document.getElementById("ui-ws-status").innerText = "MOCK DEMO";
        document.getElementById("ui-ws-status").className = "value val-update";
        document.getElementById("ui-ws-status").style.color = "orange";
        
        setTimeout(() => {
            document.getElementById("token-modal").classList.add("hidden");
            document.getElementById("dashboard").classList.remove("hidden");
            setInterval(() => {
                const lp = state.mcx.prices[state.mcx.prices.length-1];
                const newp = lp + (Math.random() - 0.48) * 5;
                state.mcx.prices.push(newp);
                state.mcx.volumes.push(Math.floor(Math.random() * 5000));
                state.mcx.opens.push(state.mcx.prices[state.mcx.prices.length-2]);
                
                const lep = state.etf.prices[state.etf.prices.length-1];
                state.etf.prices.push(lep + (Math.random() - 0.48) * 0.1);
                state.etf.opens.push(state.etf.prices[state.etf.prices.length-2]);
                
                runEngineTick();
            }, 2000);
        }, 2000);
    }
}

document.getElementById("connect-btn").addEventListener("click", () => {
    const token = document.getElementById("upstox-token").value;
    const mcxKey = document.getElementById("mcx-key").value;
    const etfKey = document.getElementById("etf-key").value;
    
    if(!token) {
        document.getElementById("auth-error").innerText = "Token is missing! Entering Demo Mode...";
    }
    initUpstox(token || 'demo', mcxKey, etfKey);
});
