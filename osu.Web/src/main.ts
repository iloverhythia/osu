// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the MIT Licence.

import './ui/styles.css';
import { Game } from './ui/Game';
import { MainMenuScreen } from './ui/screens/MainMenu';

const root = document.getElementById('app')!;
const game = new Game(root);
game.push(new MainMenuScreen(game));

// Start generating the demo set immediately so it's ready by the time the user clicks.
void game.library.load();

// Handy for debugging from the console.
(window as unknown as { osu: Game }).osu = game;
