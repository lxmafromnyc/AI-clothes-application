# Wove — AI clothing finder

A four-page static website for an AI clothing recommendation product. You tell it the
style, colour, occasion, fit, budget and brands you want; it returns a ranked shortlist
of pieces with a one-line reason for each match.

## Pages

| Page | File | What it does |
| --- | --- | --- |
| Home | `index.html` | States the value proposition immediately and points to one primary CTA |
| Find Clothes | `find-clothes.html` | Preference form (style, colour, occasion, fit, budget, brands) → ranked recommendations |
| Discover | `discover.html` | Browse the catalogue, filtered by style |
| About | `about.html` | What the site does and how the recommendation flow works |

## Running it

No build step and no dependencies — it is plain HTML, CSS and JavaScript.

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly in a browser works too.

## Structure

```
index.html, find-clothes.html, discover.html, about.html
assets/styles.css    design tokens + all shared components
assets/catalog.js    sample catalogue and card rendering
assets/app.js        navigation, recommendations, filtering
```

## How the matching works

`assets/app.js` scores every catalogue item against the selected preferences — style,
colour, occasion and fit are weighted signals, a chosen brand is a strong boost, and the
budget is a hard ceiling. Scores are normalised into the match percentage shown on each
card, and the matched signals are turned into the "why this piece" line beneath it.

## Notes

- Typeface is Inter, loaded from Google Fonts.
- Item artwork is generated in the browser from CSS gradients and inline SVG, so there
  are no image assets to load.
- The catalogue is a small sample set for demonstration; it is not real inventory.
