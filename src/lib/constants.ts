// canvas size (the html <canvas>, the overlayed <svg>, and the Stellaris map)
export const WIDTH = 900;
export const HEIGHT = 900;
// size of each "arm" of the plus sign marking the center of the canvas
export const CENTER_MARK_SIZE = 10;
// slider max for maximum connection (hyperlane) length
export const MAX_CONNECTION_LENGTH = Math.max(WIDTH, HEIGHT) / 2;
// search for empty circles to dynamically spawn FEs on game start
export const FALLEN_EMPIRE_SPAWN_RADIUS = 50;
// AI empires don't account for all spawns, so we need to have more spawn locations than allowed AI empires
export const SPAWNS_PER_MAX_AI_EMPIRE = 1.5;
