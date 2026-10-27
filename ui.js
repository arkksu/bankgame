/* Веб-интерфейс автономной версии: движок шлёт экраны (объекты) и ждёт ответы.
 *
 * Экран = {type, ctx, ...}. В ctx складывается то, что движок «показал»
 * перед запросом (шапка, стол команды, рынок, статус, заметки, логи).
 * Порт game/web_ui.py: вместо очереди ответов — Promise.
 */
"use strict";

// липкие части контекста (шапка, стол, рынок, статус) переживают экран;
// notes/logs — одноразовые.
const STICKY_KEYS = ["header", "table", "market"];

function dealCardView(c, proReq) {
  const net = c.kind === "A" ? c.income * c.term : c.payoff;
  const out = {
    id: c.id,
    name: c.name,
    sector: c.sector || "",
    body: c.body,
    term: c.term,
    risk: c.risk,
    income_text: kindStr(c),
    net,
    kind: c.kind,
  };
  if (proReq) out.pro_req = `Только для: ${proReq}`;
  return out;
}

function teamTableView(team, state, db) {
  const risk = totalRisk(team, db);
  const bank = db.bank_types[team.bank_type];
  const funding = team.funding.map((f) => {
    const c = db.funding[f.card_id];
    const rate = f.card_id === "mbk" ? stateMbkRate(state, db) : null;
    const per = c.per_round;
    const perTxt = per === "key_rate" ? `${rate} (по ставке ЦБ)` : String(per);
    const term = f.rounds_left === null || f.rounds_left === undefined
      ? "бессрочный"
      : `осталось ${f.rounds_left} р.`;
    return { name: c.name, got: c.liquidity, pay: perTxt, term };
  });
  const deals = team.deals.map((d) => {
    const c = db.deals[d.card_id];
    return {
      name: c.name,
      left: d.column,
      body: c.body,
      income_text: kindStr(c),
      risk: c.risk,
      eff_risk: dealRisk(team, d, db),
      discount: d.discount,
    };
  });
  const improvements = team.improvements.map((i) => db.improvements[i].name);
  return {
    name: team.name,
    capital: team.capital,
    liquidity: team.liquidity,
    risk,
    risk_limit: riskLimit(team, db),
    risk_ok: risk <= team.capital,
    bank: bank.name,
    deals_limit: conveyorLimit(team, db),
    monthly_cost: bank.monthly_cost,
    funding,
    deals,
    improvements,
  };
}

function statusRowView(t, state, db) {
  const risk = totalRisk(t, db);
  return {
    name: t.name,
    capital: t.capital,
    liquidity: t.liquidity,
    risk,
    deals: t.deals.length,
    funding: t.funding.length,
    risk_ok: risk <= t.capital,
  };
}

/** Вид рынка: лоты торгов + бесплатный пул (используется и панелью «Рынок»). */
function marketView(state, db) {
  const lots = state.market_lots.map((cid) =>
    dealCardView(db.deals[cid], proRequirement(db.deals[cid], db)));
  const free = [];
  for (const cid of Object.keys(state.free_pool)) {
    const n = state.free_pool[cid];
    if (n > 0) {
      const d = dealCardView(db.deals[cid], proRequirement(db.deals[cid], db));
      d.count = n;
      free.push(d);
    }
  }
  return { lots, free };
}

class WebUI {
  constructor() {
    this.ctx = {};
    this.onScreen = null;   // callback(screen) — показать экран игроку
    this._pending = null;   // resolve текущего запроса
  }

  // ---------- мост к приложению ----------

  _ask(screen) {
    const ctx = { ...this.ctx };
    delete this.ctx.notes;
    delete this.ctx.logs;
    ctx.notes = ctx.notes || [];
    ctx.logs = ctx.logs || [];
    screen.ctx = ctx;
    return new Promise((resolve) => {
      this._pending = resolve;
      if (this.onScreen) this.onScreen(screen);
    });
  }

  /** Ответ игрока на текущий экран. */
  resolve(value) {
    const r = this._pending;
    this._pending = null;
    if (r) r(value);
  }

  get waiting() {
    return this._pending !== null;
  }

  // ---------- контекст (что игрок видит) ----------

  clear() {
    for (const k of STICKY_KEYS) delete this.ctx[k];
  }

  clearNotes() {
    delete this.ctx.notes;
  }

  note(msg) {
    (this.ctx.notes || (this.ctx.notes = [])).push(msg);
  }

  log(msg, state) {
    if (state) state.log.push(msg);
    (this.ctx.logs || (this.ctx.logs = [])).push(msg);
  }

  header(state, db, extra = "") {
    const rnd = Math.min(state.round_number, db.rounds);
    const dec = db.cbDecision(rnd);
    const history = [];
    for (let r = 1; r <= rnd; r++) {
      const d = db.cbDecision(r);
      history.push({ round: r, title: d.title, text: d.text || "" });
    }
    const h = {
      round: rnd,
      rounds: db.rounds,
      cb_title: dec.title,
      cb_text: dec.text || "",
      cb_history: history,
      step: extra,
    };
    if (state.active_stress.length && state.round_number === 6) {
      h.stress = state.active_stress.map((x) => db.stress_scenarios[x].name);
    }
    this.ctx.header = h;
  }

  showMarket(state, db) {
    this.ctx.market = marketView(state, db);
  }

  showTable(team, state, db) {
    this.ctx.table = teamTableView(team, state, db);
  }

  showStatus(state, db) {
    this.ctx.status = state.teams.map((t) => statusRowView(t, state, db));
  }

  // ---------- ввод ----------

  async pause(msg = "Продолжить") {
    return this._ask({ type: "pause", msg });
  }

  async askInt(prompt, lo, hi) {
    return Number(await this._ask({ type: "input_number", prompt, lo, hi }));
  }

  async askChoice(prompt, options) {
    return Number(await this._ask({ type: "choice", prompt, options }));
  }

  async askYesNo(prompt, def = true) {
    return !!(await this._ask({ type: "yes_no", prompt, default: def }));
  }

  async askText(prompt, def = "") {
    return String(await this._ask({ type: "text", prompt, default: def }));
  }

  async throwDice() {
    return Number(await this._ask({ type: "dice" }));
  }

  async confirm(title, details) {
    return !!(await this._ask({ type: "confirm", title, details: [...details] }));
  }

  async finalScreen(results, winner) {
    return this._ask({
      type: "final",
      results,
      winner: winner.name,
      points: winner.points,
    });
  }
}
