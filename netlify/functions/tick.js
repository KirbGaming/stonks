// netlify/functions/tick.js
// Runs every minute — simulates market prices and fires the daily 9 AM MT event

const sdk = require('node-appwrite');

const ENDPOINT  = process.env.APPWRITE_ENDPOINT;
const PROJECT   = process.env.APPWRITE_PROJECT_ID;
const API_KEY   = process.env.APPWRITE_API_KEY;
const DB        = process.env.APPWRITE_DATABASE_ID;
const COL_PRICES = process.env.PRICES_COLLECTION_ID;
const COL_EVENT  = process.env.EVENT_COLLECTION_ID;

/* ── Stock definitions ── */
const STOCKS = [
  {t:'AAPL',v:.0008,sector:'Tech'},
  {t:'NVDA',v:.0014,sector:'Tech'},
  {t:'MSFT',v:.0007,sector:'Tech'},
  {t:'TSLA',v:.0018,sector:'Cars'},
  {t:'AMZN',v:.0009,sector:'Tech'},
  {t:'META',v:.0011,sector:'Tech'},
  {t:'GOOGL',v:.0008,sector:'Tech'},
  {t:'BTC',v:.0025,sector:'Crypto'},
  {t:'NKE',v:.0008,sector:'Clothing'},
  {t:'WMT',v:.0006,sector:'Retail'},
  {t:'IKEA',v:.0006,sector:'Retail'},
  {t:'ESPN',v:.0010,sector:'Sports'},
  {t:'DIS',v:.0009,sector:'Entertainment'},
];

const DEFAULT_PRICES = {
  AAPL:182.5,NVDA:875.2,MSFT:415.8,TSLA:245.3,AMZN:178.9,
  META:512.4,GOOGL:172.6,BTC:67450.0,NKE:92.80,WMT:68.40,
  IKEA:44.20,ESPN:31.50,DIS:88.60,
};

const SECTOR_GROUPS = {
  Tech:['AAPL','NVDA','MSFT','AMZN','META','GOOGL'],
  Cars:['TSLA'],Crypto:['BTC'],Clothing:['NKE'],
  Retail:['WMT','IKEA'],Sports:['ESPN'],Entertainment:['DIS','ESPN'],
};
const TICKER_SECTOR = {};
STOCKS.forEach(s => { TICKER_SECTOR[s.t] = s.sector; });
const UPWARD_DRIFT = 0.000008;

/* ── Price simulation ── */
function tieredNoise() {
  const r = Math.random();
  let mag;
  if      (r < 0.7992) mag = Math.random() * 0.35;
  else if (r < 0.9590) mag = 0.35 + Math.random() * 0.65;
  else if (r < 0.9910) mag = 1.0  + Math.random() * 1.5;
  else if (r < 0.9974) mag = 2.5  + Math.random() * 2.5;
  else                 mag = 5.0  + Math.random() * 5.0;
  return (Math.random() < 0.5 ? 1 : -1) * mag;
}

function tickPrice(ticker, vol, state, sectorDrift) {
  const s     = state.stocks[ticker];
  const prev  = s.price;
  const mom   = s.momentum   || 0;
  const fv    = s.fairValue  || prev;
  const boost = s.eventBoost || 0;
  const sect  = sectorDrift[TICKER_SECTOR[ticker]] || 0;

  const momBias        = mom * 0.18;
  const reversionForce = -((prev - fv) / fv) * 0.009;
  const sectBias       = sect * 0.35;
  const biasedVol      = vol * (1 + Math.abs(boost) * 4);
  const drift          = boost * 0.4 + momBias + reversionForce + sectBias;

  const noise    = tieredNoise();
  const newPrice = Math.max(0.01, prev * (1 + (noise + drift) * biasedVol * 2 + UPWARD_DRIFT));

  s.momentum  = mom * 0.82 + ((newPrice - prev) / prev) * 0.18;
  s.fairValue = (s.fairValue || prev) * (1 + UPWARD_DRIFT * 0.6);
  s.prevPrice = prev;
  s.price     = newPrice;

  const dir = newPrice >= prev ? 'up' : 'down';
  if (dir !== s.streakDir) { s.streakBase = prev; s.streakDir = dir; }

  // Decay event boost slowly (lasts most of the day)
  if (boost !== 0) {
    s.eventBoost = Math.abs(boost) < 0.0001 ? 0 : boost * 0.998;
  }
}

/* ── News events (server-side subset — no images/descriptions needed) ── */
const SEVERITY_MULTIPLIER = {Light:.006,Moderate:.014,Heavy:.028,Extreme:.05,Absurd:.10};
const FV_SHIFT            = {Light:.004,Moderate:.012,Heavy:.028,Extreme:.055,Absurd:.11};

const NEWS_EVENTS = [
  {EventName:'badlands_chugs_drinks_oil',EventType:'Cars',   EventAffect:'Negative',EventSeverity:'Absurd'},
  {EventName:'apple_iphone21_launch',    EventType:'AAPL',   EventAffect:'Positive',EventSeverity:'Extreme'},
  {EventName:'apple_vs_amir',            EventType:'AAPL',   EventAffect:'Negative',EventSeverity:'Extreme'},
  {EventName:'nvda_lebron_contract',     EventType:'NVDA',   EventAffect:'Positive',EventSeverity:'Absurd'},
  {EventName:'nvda_export_ban',          EventType:'NVDA',   EventAffect:'Negative',EventSeverity:'Extreme'},
  {EventName:'elon_fortnite_collab',     EventType:'TSLA',   EventAffect:'Negative',EventSeverity:'Moderate'},
  {EventName:'tsla_gigafactory',         EventType:'TSLA',   EventAffect:'Positive',EventSeverity:'Heavy'},
  {EventName:'meta_military_helmet',     EventType:'META',   EventAffect:'Positive',EventSeverity:'Heavy'},
  {EventName:'zuck_forgets_lines',       EventType:'META',   EventAffect:'Negative',EventSeverity:'Moderate'},
  {EventName:'msft_ai',                  EventType:'MSFT',   EventAffect:'Positive',EventSeverity:'Moderate'},
  {EventName:'msft_product_key',         EventType:'MSFT',   EventAffect:'Negative',EventSeverity:'Extreme'},
  {EventName:'amzn_new_delivery_missle', EventType:'AMZN',   EventAffect:'Positive',EventSeverity:'Moderate'},
  {EventName:'amzn_delivery_missle',     EventType:'AMZN',   EventAffect:'Negative',EventSeverity:'Absurd', PreReq:'amzn_new_delivery_missle'},
  {EventName:'googl_gemini_syria',       EventType:'GOOGL',  EventAffect:'Negative',EventSeverity:'Absurd'},
  {EventName:'googl_gemini_solves_hunger',EventType:'GOOGL', EventAffect:'Positive',EventSeverity:'Heavy'},
];

function getAffectedTickers(type) {
  const map = {
    Tech:['AAPL','NVDA','MSFT','AMZN','META','GOOGL'],
    Cars:['TSLA'],Crypto:['BTC'],Clothing:['NKE'],
    Retail:['WMT','IKEA'],Entertainment:['DIS','ESPN'],Sports:['ESPN'],
    AAPL:['AAPL'],NVDA:['NVDA'],MSFT:['MSFT'],TSLA:['TSLA'],
    AMZN:['AMZN'],META:['META'],GOOGL:['GOOGL'],BTC:['BTC'],
    NKE:['NKE'],WMT:['WMT'],IKEA:['IKEA'],ESPN:['ESPN'],DIS:['DIS'],
  };
  return map[type] || STOCKS.map(s => s.t);
}

/* ── Main handler (called every minute by Netlify scheduler) ── */
exports.handler = async function() {
  const client = new sdk.Client()
    .setEndpoint(ENDPOINT)
    .setProject(PROJECT)
    .setKey(API_KEY);
  const db = new sdk.Databases(client);

  /* 1 ─ Load current price state */
  let state;
  let docExists = false;
  try {
    const doc = await db.getDocument(DB, COL_PRICES, 'current');
    state = JSON.parse(doc.data);
    docExists = true;
  } catch(e) {
    // First ever run — initialise all stocks
    state = { firedEvents: [], stocks: {} };
    STOCKS.forEach(s => {
      state.stocks[s.t] = {
        price:      DEFAULT_PRICES[s.t],
        momentum:   0,
        fairValue:  DEFAULT_PRICES[s.t],
        streakDir:  'up',
        streakBase: DEFAULT_PRICES[s.t],
        prevPrice:  DEFAULT_PRICES[s.t],
        eventBoost: 0,
      };
    });
  }
  if (!state.stocks)      state.stocks      = {};
  if (!state.firedEvents) state.firedEvents = [];

  /* 2 ─ Generate fresh sector drift nudges */
  const sectorDrift = {};
  Object.keys(SECTOR_GROUPS).forEach(sec => {
    sectorDrift[sec] = (Math.random() - 0.5) * 0.007;
  });

  /* 3 ─ Tick every stock price */
  STOCKS.forEach(s => {
    if (!state.stocks[s.t]) {
      state.stocks[s.t] = {
        price:DEFAULT_PRICES[s.t],momentum:0,fairValue:DEFAULT_PRICES[s.t],
        streakDir:'up',streakBase:DEFAULT_PRICES[s.t],prevPrice:DEFAULT_PRICES[s.t],eventBoost:0,
      };
    }
    tickPrice(s.t, s.v, state, sectorDrift);
  });

  /* 4 ─ Check daily event (fires at 09:00 Mountain Daylight Time = 15:00 UTC) */
  const now      = new Date();
  const utcHour  = now.getUTCHours();
  const todayStr = now.toDateString();

  if (utcHour >= 15) {
    let existingDate = null;
    try {
      const evDoc = await db.getDocument(DB, COL_EVENT, 'today');
      existingDate = evDoc.date;
    } catch(e) { /* no event doc yet */ }

    if (existingDate !== todayStr) {
      const fired = state.firedEvents || [];
      const pool  = NEWS_EVENTS.filter(e =>
        !fired.includes(e.EventName) &&
        (!e.PreReq || fired.includes(e.PreReq))
      );

      if (pool.length > 0) {
        const ev  = pool[Math.floor(Math.random() * pool.length)];
        const dir = ev.EventAffect === 'Positive' ? 1 : -1;
        const boost   = (SEVERITY_MULTIPLIER[ev.EventSeverity] || 0.01) * dir;
        const fvShift = (FV_SHIFT[ev.EventSeverity] || 0.004) * (0.85 + Math.random() * 0.3);

        getAffectedTickers(ev.EventType).forEach(t => {
          if (state.stocks[t]) {
            state.stocks[t].eventBoost = (state.stocks[t].eventBoost || 0) + boost;
            state.stocks[t].fairValue  = (state.stocks[t].fairValue || DEFAULT_PRICES[t]) * (1 + dir * fvShift);
          }
        });

        state.firedEvents = [...fired, ev.EventName];

        const evData = JSON.stringify(ev);
        try {
          await db.updateDocument(DB, COL_EVENT, 'today',
            {eventName:ev.EventName, date:todayStr, data:evData});
        } catch(e) {
          await db.createDocument(DB, COL_EVENT, 'today',
            {eventName:ev.EventName, date:todayStr, data:evData});
        }
      }
    }
  }

  /* 5 ─ Save updated price state */
  const priceData = JSON.stringify(state);
  try {
    if (docExists) {
      await db.updateDocument(DB, COL_PRICES, 'current', {data:priceData});
    } else {
      await db.createDocument(DB, COL_PRICES, 'current', {data:priceData});
    }
  } catch(e) {
    console.error('Price save failed:', e.message);
    return {statusCode:500, body:'Price save failed'};
  }

  return {statusCode:200, body:'ok'};
};
