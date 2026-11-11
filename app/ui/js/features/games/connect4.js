// Conecta 4: tablero de 7 columnas y 6 filas; se toca una columna y la ficha
// cae hasta abajo. Cuatro seguidas (en línea, columna o diagonal) ganan.
// Empieza quien invitó. Cada equipo comprueba las jugadas del otro (su
// turno, columna con hueco), así que los dos ven el mismo final.

import { t } from '../../i18n/index.js';

const COLS = 7;
const ROWS = 6;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

export default {
  id: 'connect4',
  icon: 'discs',

  create({ board, me, them, send, status, end }) {
    // cells[fila * COLS + col], fila 0 arriba.
    const cells = Array(COLS * ROWS).fill(null);
    let turn = 'host';
    let over = false;

    board.innerHTML = `<div class="c4">${cells
      .map((_, i) => `<button type="button" class="c4-cell" data-col="${i % COLS}" aria-label="${i % COLS + 1}"><span class="c4-disc"></span></button>`)
      .join('')}</div>`;
    const buttons = [...board.querySelectorAll('.c4-cell')];

    /** La fila donde caería una ficha en `col`, o -1 si está llena. */
    const landing = (col) => {
      for (let row = ROWS - 1; row >= 0; row--) if (!cells[row * COLS + col]) return row;
      return -1;
    };

    /** Las cuatro (o más) en raya que pasan por `row`,`col`, si las hay. */
    function line(row, col) {
      const who = cells[row * COLS + col];
      for (const [dc, dr] of DIRS) {
        const run = [[row, col]];
        for (const sign of [1, -1]) {
          let r = row + dr * sign;
          let c = col + dc * sign;
          while (r >= 0 && r < ROWS && c >= 0 && c < COLS && cells[r * COLS + c] === who) {
            run.push([r, c]);
            r += dr * sign;
            c += dc * sign;
          }
        }
        if (run.length >= 4) return run;
      }
      return null;
    }

    function render() {
      buttons.forEach((b, i) => {
        b.dataset.who = cells[i] ? (cells[i] === me ? 'mine' : 'theirs') : '';
        b.disabled = over || turn !== me || landing(i % COLS) < 0;
      });
      if (!over) status(turn === me ? t('game.your_turn') : t('game.their_turn', { name: them }));
    }

    function play(col, who) {
      if (over || who !== turn || !(col >= 0 && col < COLS)) return false;
      const row = landing(col);
      if (row < 0) return false;
      cells[row * COLS + col] = who;
      turn = who === 'host' ? 'guest' : 'host';
      // La ficha cae desde arriba: más filas, más recorrido.
      const disc = buttons[row * COLS + col];
      disc.style.setProperty('--fall', row + 1);
      disc.classList.add('drop');
      const won = line(row, col);
      if (won) {
        over = true;
        for (const [r, c] of won) buttons[r * COLS + c].classList.add('win');
        render();
        end(who === me ? 'win' : 'lose');
      } else if (cells.every(Boolean)) {
        over = true;
        render();
        end('draw');
      } else {
        render();
      }
      return true;
    }

    board.querySelector('.c4').addEventListener('click', (ev) => {
      const col = Number(ev.target.closest('.c4-cell')?.dataset.col);
      if (Number.isInteger(col) && turn === me && play(col, me)) send({ col });
    });

    render();
    return {
      receive(data) {
        play(Number(data?.col), me === 'host' ? 'guest' : 'host');
      },
    };
  },
};
