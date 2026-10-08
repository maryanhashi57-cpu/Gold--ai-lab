// Gold AI Lab - Rule-based XAU/USD scalping prototype
// Testing only. Does not place trades. No fixed-duration exits.
// One Twelve Data API request per analysis refresh: aggregate 1m bars
// into 5m and 15m context to conserve API credits.

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API key is missing' });
    }

    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', 'XAU/USD');
    url.searchParams.set('interval', '1min');
    url.searchParams.set('outputsize', '240');
    url.searchParams.set('timezone', 'UTC');
    url.searchParams.set('apikey', apiKey);

    const response = await fetch(url.toString());
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.values)) {
      throw new Error(data.message || 'Could not retrieve gold candles');
    }

    function parseTime(s) {
      const normalized = String(s).trim().replace(' ', 'T');
      return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(normalized)
        ? normalized : normalized + 'Z');
    }

    const all1m = data.values.map(c => ({
      timestamp: parseTime(c.datetime),
      open: Number(c.open), high: Number(c.high),
      low: Number(c.low), close: Number(c.close)
    })).filter(c => Number.isFinite(c.timestamp) &&
      [c.open, c.high, c.low, c.close].every(Number.isFinite))
      .sort((a, b) => b.timestamp - a.timestamp);

    // Candle times represent their opening minute. Only use closed bars.
    const now = Date.now();
    const m1 = all1m.filter(c => c.timestamp + 60000 <= now);
    if (m1.length < 55) throw new Error('Not enough completed 1-minute candles');

    function aggregate(bars, minutes) {
      const bucketMs = minutes * 60000;
      const groups = new Map();
      for (const c of bars) {
        const start = Math.floor(c.timestamp / bucketMs) * bucketMs;
        if (!groups.has(start)) groups.set(start, []);
        groups.get(start).push(c);
      }
      const result = [];
      for (const [start, group] of groups) {
        group.sort((a, b) => a.timestamp - b.timestamp);
        // Avoid creating 5m/15m candles from incomplete market data.
        if (group.length !== minutes ||
            !group.every((c, i) => c.timestamp === start + i * 60000)) continue;
        result.push({
          timestamp: start,
          open: group[0].open,
          high: Math.max(...group.map(c => c.high)),
          low: Math.min(...group.map(c => c.low)),
          close: group[group.length - 1].close
        });
      }
      return result.sort((a, b) => b.timestamp - a.timestamp);
    }

    const m5 = aggregate(m1, 5);
    const m15 = aggregate(m1, 15);
    if (m5.length < 7 || m15.length < 7) {
      throw new Error('Not enough complete 5m/15m candles yet');
    }

    function averageRange(bars) {
      return bars.reduce((sum, c) => sum + (c.high - c.low), 0) / bars.length;
    }
    function bias(bars) {
      const six = bars.slice(0, 6);
      const move = six[0].close - six[5].close;
      const threshold = averageRange(six) * 0.35;
      if (move > threshold) return 'Bullish';
      if (move < -threshold) return 'Bearish';
      return 'Neutral';
    }

    const bias15m = bias(m15);
    const bias5m = bias(m5);
    const candle = m1[0];
    const prev = m1[1];
    const history = m1.slice(1, 9);
    const priorHigh = Math.max(...history.map(c => c.high));
    const priorLow = Math.min(...history.map(c => c.low));
    const avg1m = averageRange(m1.slice(0, 14));
    const range = candle.high - candle.low;
    const body = Math.abs(candle.close - candle.open);
    const strongCandle = range > 0 && body >= 0.5 * range &&
      range >= 0.25 * avg1m && range <= 2.5 * avg1m;

    // Two types of setup: a liquidity rejection OR a strong continuation.
    const bullishSweep = candle.low < priorLow && candle.close > priorLow &&
      candle.close > candle.open;
    const bearishSweep = candle.high > priorHigh && candle.close < priorHigh &&
      candle.close < candle.open;
    const bullishContinuation = candle.close > prev.high &&
      candle.close > candle.open && strongCandle;
    const bearishContinuation = candle.close < prev.low &&
      candle.close < candle.open && strongCandle;

    let signal = 'WAIT';
    let setup = 'None';
    let entry = null, stopLoss = null, takeProfit1 = null, takeProfit2 = null;
    const reasons = [];

    if (now - candle.timestamp > 3 * 60000) {
      reasons.push('Market data is stale or the market is closed.');
    } else if (bias15m === 'Neutral') {
      reasons.push('15-minute market direction is unclear.');
    } else if (bias5m !== bias15m) {
      reasons.push('5-minute direction does not agree with the 15-minute trend.');
    } else if (!strongCandle && !bullishSweep && !bearishSweep) {
      reasons.push('No sufficiently clear 1-minute confirmation yet.');
    } else {
      const buy = bias15m === 'Bullish' &&
        (bullishSweep || bullishContinuation);
      const sell = bias15m === 'Bearish' &&
        (bearishSweep || bearishContinuation);
      if (buy || sell) {
        const proposedEntry = candle.close;
        // Latest fetched quote may be from a still-forming bar.
        const latestQuote = all1m[0].close;
        const tooFar = Math.abs(latestQuote - proposedEntry) > avg1m * 0.75;
        const buffer = avg1m * 0.15;
        const swing = buy
          ? Math.min(...m1.slice(0, 5).map(c => c.low)) - buffer
          : Math.max(...m1.slice(0, 5).map(c => c.high)) + buffer;
        const risk = Math.abs(proposedEntry - swing);
        if (tooFar) {
          reasons.push('The latest quote has moved too far from the setup; do not chase.');
        } else if (risk < avg1m * 0.3 || risk > avg1m * 4) {
          reasons.push('Stop distance is outside this prototype’s risk filter.');
        } else {
          signal = buy ? 'BUY' : 'SELL';
          setup = buy
            ? (bullishSweep ? 'Bullish liquidity rejection' : 'Bullish continuation')
            : (bearishSweep ? 'Bearish liquidity rejection' : 'Bearish continuation');
          entry = proposedEntry;
          stopLoss = swing;
          takeProfit1 = entry + (buy ? risk : -risk);
          takeProfit2 = entry + (buy ? 1.5 * risk : -1.5 * risk);
          reasons.push(`${bias15m} 15m and 5m context with ${setup.toLowerCase()}.`);
          reasons.push('Indicative prices from candle data; verify spread and broker quote.');
        }
      } else {
        reasons.push('No 1-minute setup in the trend direction.');
      }
    }

    const rounded = v => v == null ? null : Number(v.toFixed(2));
    return res.status(200).json({
      symbol: 'XAU/USD', mode: 'scalping-prototype',
      signal, setup, bias15m, bias5m,
      price: rounded(all1m[0].close),
      entry: rounded(entry), stopLoss: rounded(stopLoss),
      takeProfit1: rounded(takeProfit1), takeProfit2: rounded(takeProfit2),
      reasons, candleTime: new Date(candle.timestamp).toISOString(),
      updated: new Date().toISOString(),
      note: 'Demo signal only; no automatic trades or fixed-time exits.'
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Could not analyze gold market', details: error.message
    });
  }
};
