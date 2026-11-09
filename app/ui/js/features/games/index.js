// Los minijuegos. Para añadir uno: un módulo como `tictactoe.js` y ponerlo
// en esta lista (y sus textos `game.<id>` y `game.<id>_desc`).
//
// Cada juego es un objeto con:
//   id      nombre corto que viaja en la invitación (no cambiarlo nunca)
//   icon    icono de lib/icons.js para la lista
//   create({ board, me, them, send, status, end })
//     board   el elemento donde se dibuja
//     me      'host' (quien invitó, empieza) o 'guest'
//     them    nombre del otro
//     send    send(data): manda una jugada al otro (JSON pequeño)
//     status  status(texto): la línea bajo el título (de quién es el turno…)
//     end     end('win' | 'lose' | 'draw'): la partida terminó (en los dos
//             equipos sale lo mismo, cada uno lo calcula con las jugadas)
//   y devuelve { receive(data) } para las jugadas del otro.

import tictactoe from './tictactoe.js';

export const GAMES = [tictactoe];

export const findGame = (id) => GAMES.find((g) => g.id === id) || null;
