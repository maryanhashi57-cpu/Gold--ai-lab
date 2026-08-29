module.exports = async function handler(req, res) {

  try {

    const apiKey = process.env.TWELVE_DATA_API_KEY;

    if (!apiKey) {

      return res.status(500).json({ error: "API key is missing" });

    }

    const response = await fetch(

      `https://api.twelvedata.com/price?symbol=XAU%2FUSD&apikey=${apiKey}`

    );

    const data = await response.json();

    return res.status(200).json({

      symbol: "XAU/USD",

      price: data.price,

      updated: new Date().toISOString()

    });

  } catch (error) {

    return res.status(500).json({ error: "Could not get gold price" });
