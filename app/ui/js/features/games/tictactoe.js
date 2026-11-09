// Tres en raya: empieza quien invitó (X). Cada equipo comprueba las jugadas
// del otro (su turno, casilla libre), así que los dos ven el mismo final.

import { t } from '../../i18n/index.js';

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export default {
  id: 'tictactoe',
  icon: 'grid',

  create({ board, me, them, send, status, end }) {
    const cells = Array(9).fill(null);
    let turn = 'host';
    let over = false;

    board.innerHTML = `<div class="ttt">${cells.map((_, i) => `<button type="button" class="ttt-cell" data-i="${i}"></button>`).join('')}</div>`;
    const buttons = [...board.querySelectorAll('.ttt-cell')];

    const mark = (who) => (who === 'host' ? 'X' : 'O');

    function render() {
      buttons.forEach((b, i) => {
        b.textContent = cells[i] ? mark(cells[i]) : '';
        b.classList.toggle('mine', cells[i] === me);
        b.disabled = over || !!cells[i] || turn !== me;
      });
      if (!over) status(turn === me ? t('game.your_turn') : t('game.their_turn', { name: them }));
    }

    function play(i, who) {
      if (over || who !== turn || cells[i] || !(i >= 0 && i < 9)) return false;
      cells[i] = who;
      turn = who === 'host' ? 'guest' : 'host';
      const line = LINES.find(([a, b, c]) => cells[a] && cells[a] === cells[b] && cells[a] === cells[c]);
      if (line) {
        over = true;
        for (const n of line) buttons[n].classList.add('win');
        render();
        end(cells[line[0]] === me ? 'win' : 'lose');
      } else if (cells.every(Boolean)) {
        over = true;
        render();
        end('draw');
      } else {
        render();
      }
      return true;
    }

    board.querySelector('.ttt').addEventListener('click', (ev) => {
      const i = Number(ev.target.closest('.ttt-cell')?.dataset.i);
      if (Number.isInteger(i) && turn === me && play(i, me)) send({ cell: i });
    });

    render();
    return {
      receive(data) {
        play(Number(data?.cell), me === 'host' ? 'guest' : 'host');
      },
    };
  },
};
