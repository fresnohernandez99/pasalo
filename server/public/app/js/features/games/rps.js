// Piedra, papel o tijera, al mejor de tres (gana quien llega a 2; los
// empates se repiten). Las jugadas son a la vez, así que nadie puede esperar
// a ver la del otro: cada uno manda primero un compromiso (el SHA-256 de su
// jugada con un secreto al azar) y solo cuando tiene el del otro revela la
// jugada y el secreto. Una revelación que no cuadra con su compromiso es
// trampa y pierde.
//
// Mensajes: `{ r, commit }` y `{ r, choice, salt }`, con `r` el número de
// ronda. Pueden llegar desordenados: se guardan por ronda.

import { t } from '../../i18n/index.js';

const CHOICES = ['rock', 'paper', 'scissors'];
const EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const TARGET = 2;
/** Lo que se ve el resultado de una ronda antes de la siguiente. */
const PAUSE_MS = 1800;

async function sha256(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

const randomSalt = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

export default {
  id: 'rps',
  icon: 'scissors',

  create({ board, them, send, status, end }) {
    let round = 1;
    let over = false;
    const score = { me: 0, them: 0 };
    // Por ronda: lo mío ({ choice, salt, commit, revealed }) y lo suyo ({ commit, choice, salt }).
    const mine = new Map();
    const theirs = new Map();
    const theirsOf = (r) => theirs.get(r) || theirs.set(r, {}).get(r);

    board.innerHTML = `
      <div class="rps">
        <div class="rps-score"></div>
        <div class="rps-arena"><span class="rps-hand me"></span><span class="rps-vs">vs</span><span class="rps-hand them"></span></div>
        <div class="rps-picks">${CHOICES.map((c) => `<button type="button" class="rps-pick" data-choice="${c}" aria-label="${t(`game.rps_${c}`)}" title="${t(`game.rps_${c}`)}">${EMOJI[c]}</button>`).join('')}</div>
      </div>`;
    const $ = (sel) => board.querySelector(sel);
    const picks = [...board.querySelectorAll('.rps-pick')];

    function render() {
      $('.rps-score').textContent = t('game.rps_score', { me: score.me, them: score.them, name: them });
      const m = mine.get(round);
      const waiting = !!m || over;
      for (const b of picks) {
        b.disabled = waiting;
        b.classList.toggle('chosen', m?.choice === b.dataset.choice);
      }
      if (over) return;
      if (!m) {
        $('.rps-hand.me').textContent = '❔';
        $('.rps-hand.them').textContent = theirsOf(round).commit ? '✔️' : '❔';
        status(t('game.rps_pick', { round }));
      } else {
        $('.rps-hand.me').textContent = EMOJI[m.choice];
        status(t('game.rps_waiting', { name: them }));
      }
    }

    async function pick(choice) {
      if (over || mine.has(round)) return;
      const r = round;
      const salt = randomSalt();
      const entry = { choice, salt, commit: '', revealed: false };
      mine.set(r, entry);
      render();
      entry.commit = await sha256(`${r}:${choice}:${salt}`);
      send({ r, commit: entry.commit });
      progress();
    }

    /** Revela cuando los dos se comprometieron y resuelve cuando llega lo del otro. */
    async function progress() {
      const r = round;
      const m = mine.get(r);
      const o = theirsOf(r);
      if (!m?.commit || !o.commit) return;
      if (!m.revealed) {
        m.revealed = true;
        send({ r, choice: m.choice, salt: m.salt });
      }
      if (!o.choice || o.done) return;
      o.done = true;
      const honest = CHOICES.includes(o.choice) && (await sha256(`${r}:${o.choice}:${o.salt}`)) === o.commit;
      if (over || r !== round) return;
      if (!honest) {
        over = true;
        status(t('game.rps_cheat', { name: them }));
        end('win');
        return;
      }
      $('.rps-hand.me').textContent = EMOJI[m.choice];
      $('.rps-hand.them').textContent = EMOJI[o.choice];
      const result = m.choice === o.choice ? 'draw' : BEATS[m.choice] === o.choice ? 'win' : 'lose';
      if (result === 'win') score.me++;
      if (result === 'lose') score.them++;
      $('.rps-score').textContent = t('game.rps_score', { me: score.me, them: score.them, name: them });
      if (score.me >= TARGET || score.them >= TARGET) {
        over = true;
        render();
        end(score.me > score.them ? 'win' : 'lose');
        return;
      }
      status(t(`game.rps_round_${result}`, { name: them }));
      for (const b of picks) b.disabled = true;
      setTimeout(() => {
        if (over || r !== round) return;
        round++;
        render();
        // Puede que el otro ya mandara su compromiso de la siguiente.
        progress();
      }, PAUSE_MS);
    }

    $('.rps-picks').addEventListener('click', (ev) => {
      const choice = ev.target.closest('.rps-pick')?.dataset.choice;
      if (choice) pick(choice);
    });

    render();
    return {
      receive(data) {
        const r = Number(data?.r);
        // Solo la ronda de ahora o la siguiente (si él va más rápido).
        if (over || !(r === round || r === round + 1)) return;
        const o = theirsOf(r);
        if (typeof data.commit === 'string' && !o.commit) o.commit = data.commit.slice(0, 64);
        if (typeof data.choice === 'string' && typeof data.salt === 'string' && !o.choice) {
          o.choice = data.choice;
          o.salt = data.salt.slice(0, 64);
        }
        if (r === round) {
          if (!mine.has(round)) render();
          progress();
        }
      },
    };
  },
};
