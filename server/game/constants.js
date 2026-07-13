'use strict';

const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  devCard: { sheep: 1, wheat: 1, ore: 1 },
};

// Mazo oficial: 14 caballeros, 5 puntos de victoria, 2x2 progresos.
const DEV_DECK = [
  ...Array(14).fill('knight'),
  ...Array(5).fill('victoryPoint'),
  ...Array(2).fill('roadBuilding'),
  ...Array(2).fill('yearOfPlenty'),
  ...Array(2).fill('monopoly'),
];

const PIECES = { roads: 15, settlements: 5, cities: 4 };

const BANK_PER_RESOURCE = 19;

const VP_TO_WIN = 10;

const PLAYER_COLORS = ['#c0392b', '#2471a3', '#e8e4d8', '#e67e22'];
const PLAYER_COLOR_NAMES = ['rojo', 'azul', 'blanco', 'naranja'];

module.exports = {
  RESOURCES, COSTS, DEV_DECK, PIECES, BANK_PER_RESOURCE, VP_TO_WIN,
  PLAYER_COLORS, PLAYER_COLOR_NAMES,
};
