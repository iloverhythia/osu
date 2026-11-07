# Idle for Rhythia (clone)

A from-scratch recreation of the browser idle game at rhythiaidle.space. Your player plays rhythm maps on its own; you spend what it earns, pick its maps, mods and speed, and decide when a season ends.

It is a static site, published with GitHub Pages at https://iloverhythia.github.io/osu/ by the `rhythia-idle-pages` workflow. To run it locally, serve this folder (for example `python3 -m http.server`) and open `index.html`. Progress saves to the browser's local storage.

## What is in it

- **Play view**: the bot plays on a 3×3 grid with approaching notes, cursor and trail, combo, accuracy, misses, health, live RP widget, the map scoreboard, the skill profile for the current map, the warm-up bar and the Up next queue.
- **Maps**: the public Rhythia catalogue (4,099 maps with title, mapper, star rating, length, note count, play count, pattern shares and cover art), tier tabs, search, sorts (including "most streams", pass chance and your best RP), status filter, daily maps per tier with the day's mod, playlists, speeds from 0.75× to 2× and 20 mods.
- **Skills**: 13 skills (16 after Ascension) levelled by playing, gear with 15 tiers per skill and set bonuses, instincts with Natural, Head start, Gifted, Craft and twigs, perks, Devotion, prestige, the star shop and star milestones, shard unlocks and Overdrive.
- **Resets**: seasons (stars and instinct points from RP), rebirths with 20 unlocks, Ascension with Trials and Relics, Transcendence with the echo tree.
- **Everything else**: results screen with health graph, profile with RP graph, best plays, weekly challenges, achievements and season badges, rankings, guide, settings (interface, cursor, notes, backgrounds, widgets, streamer), a Find palette, offline catch-up with a welcome-back report, and a title screen.

## What is different from the original

- There is no game server. Rankings, the online list and chat run locally with simulated players; scores stay on this device.
- Note charts are generated per map from its length, note count and pattern shares, so maps play the same every time but do not match the real charts note for note.
- No song audio ships with it. "Music" plays a soft generated pad.
- Discord login is replaced by a name you pick in Settings or on the Profile page.

Map names, mappers, ratings and cover art come from the public Rhythia map listing and belong to Rhythia and the mappers and artists behind them.

## Files

- `index.html`, `style.css`: the page and its styles.
- `js/data.js`: balance numbers and content tables.
- `js/maps.js`: catalogue helpers, chart generation, daily and weekly picks.
- `js/engine.js`: state, formulas, the play simulation, progression, save and load, offline catch-up, bots.
- `js/ui.js`: every screen.
- `data/maps.js`: the map catalogue.
