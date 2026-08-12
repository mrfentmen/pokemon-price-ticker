# PokéTicker: Pokémon Card Prices

Search any Pokémon card and watch its market price like a stock ticker — because at this point they basically are. Add Charizard, Pikachu, or whatever you're holding and see the live market price, the 1d/7d/30d sale-average trend, and a scrolling ticker tape right from your toolbar.

## Features

- Card search against the free Pokemon TCG API (pokemontcg.io v2)
- Priced cards rank first, so brand-new promos with no market data yet don't bury the cards you can actually trade
- Market price per variant (holofoil / normal / reverse) straight from TCGplayer
- Trend arrows from Cardmarket's 1d/7d/30d sale averages — the "stock" part
- Scrolling ticker tape across the top of the popup
- One click to open any card on TCGplayer
- Auto-refresh of all quotes while the popup is open
- 12s fetch timeout, retries with a growing backoff, and honest "feed is hiccuping" messages when the API is having a bad day
- Offline fallback: the last good quotes stay on screen with their age ("Offline — quotes from 3h ago"), color-coded green/amber/red by how stale
- Watchlist persists locally, and Ctrl/Cmd +/−/0 zooms the popup if it feels small

## Permissions (least privilege)

- `storage` only, to persist your watchlist locally.
- Host access is limited to `https://api.pokemontcg.io/*` for card data and prices.
- No page access, no content scripts, no tracking.

## Privacy

Your watchlist never leaves your browser. The only network calls are to the Pokemon TCG API for card data and prices, with a descriptive User-Agent identifying the extension. See PRIVACY.md.

## Support

Free forever. If the ticker pays for itself, a coffee is appreciated: https://www.buymeacoffee.com/contactae2b. Found a bug? Email contactae2000@gmail.com.

## Development

```bash
npm run syntax   # syntax check the modules
npm test         # unit tests
```
