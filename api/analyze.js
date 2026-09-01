module.exports = async function handler(req, res) {
  try {
    const apiKey = process.env.TWELVE_DATA_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "API key is missing" });
    }

    async function getCandles(interval) {
      const url =
        `https://api.twelvedata.com/time_series?symbol=XAU%2FUSD&interval=${interval}&outputsize=20&apikey=${apiKey}`;

      const response = await fetch(url);
      const data = await response.json();

      if (!data.values || !Array.isArray(data.values)) {
        throw new Error(data.message || `Could not get ${interval} candles`);
      }

      return data.values.map(c => ({
        datetime: c.datetime,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }));
    }

    const [h4, h1, m5] = await Promise.all([
      getCandles("4h"),
      getCandles("1h"),
      getCandles("5min")
    ]);

    function getBias(candles) {
      const latest = candles[0].close;
      const older = candles[5].close;

      if (latest > older) return "Bullish";
      if (latest < older) return "Bearish";
      return "Neutral";
    }

    const latest5 = m5[0];
    const previous5 = m5.slice(1, 11);

    const previousHigh = Math.max(...previous5.map(c => c.high));
    const previousLow = Math.min(...previous5.map(c => c.low));

    let sweep = "No / unclear";

    if (latest5.low < previousLow && latest5.close > previousLow) {
      sweep = "Sell-side liquidity swept";
    } else if (latest5.high > previousHigh && latest5.close < previousHigh) {
      sweep = "Buy-side liquidity swept";
    }

    let confirmation = "None";

    if (latest5.close > latest5.open) {
      confirmation = "Bullish confirmation";
    } else if (latest5.close < latest5.open) {
      confirmation = "Bearish confirmation";
    }

    return res.status(200).json({
      symbol: "XAU/USD",
      price: latest5.close,
      bias4h: getBias(h4),
      bias1h: getBias(h1),
      liquiditySweep: sweep,
      confirmation5m: confirmation,
      updated: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
      error: "Could not analyze gold market",
      details: error.message
    });
  }
};
