/* Банковская игра — движок на чистом JS (без сервера и без Python).
 *
 * Порт: game/core.py, game/cards.py, game/textutil.py, game/engine.py.
 * Движок не рисует сам: он создаёт экраны через объект ui (см. ui.js)
 * и ждёт ответы игрока — методы ввода возвращают Promise.
 */
"use strict";

// ============ вспомогательные функции ============

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function choice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ============ textutil.py ============

/** Склонение: 1 очко, 2 очка, 5 очков. */
function plural(n, one, few, many) {
  if (n % 10 === 1 && n % 100 !== 11) return one;
  if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return few;
  return many;
}

/** Понятное описание выплат сделки без терминов «Тип А/Б». */
function kindStr(card) {
  if (card.kind === "A") {
    const total = card.income * card.term;
    return `доход каждый раунд +${card.income} (всего +${total})`;
  }
  return `весь куш в конце +${card.payoff}`;
}

/** Имена банков, которым доступна PRO-сделка (иначе null). */
function proRequirement(card, db) {
  const pro = card.pro;
  if (!pro) return null;
  const names = Object.values(db.bank_types)
    .filter((b) => (b.pro || []).includes(pro))
    .map((b) => b.name);
  return names.length ? names.join(", ") : "недоступна";
}

/** Чистый доход сделки: Тип А — суммарный, Тип Б — куш. */
function dealNet(card) {
  return card.kind === "A" ? card.income * card.term : card.payoff;
}

function cPerTxt(f, rate) {
  return String(f.per_round === "key_rate" ? rate : f.per_round);
}

function deductCapital(team, amount) {
  team.capital = Math.max(0, team.capital - amount);
}

function stateMbkRate(state, db) {
  return db.mbkRate(state.round_number, state.active_stress);
}

// ============ cards.py: CardDB ============

class CardDB {
  constructor(data) {
    this.raw = data;
    this.rounds = data.rounds;
    this.starting_capital = data.starting_capital;
    this.starting_liquidity = data.starting_liquidity;
    this.auction_lots_extra = data.auction_lots_extra;
    this.free_deal_copies = data.free_deal_copies;
    this.auction_deal_copies = data.auction_deal_copies;
    this.pro_deal_copies = data.pro_deal_copies ?? data.auction_deal_copies;
    this.discount_cards = [...data.discount_cards];
    this.capital_exchange_rate = data.capital_exchange_rate;
    this.risk_line_max = data.risk_line_max;

    this.funding = {};
    for (const f of data.funding) this.funding[f.id] = f;
    this.deals = {};
    for (const d of data.deals) this.deals[d.id] = d;
    this.improvements = {};
    for (const i of data.improvements) this.improvements[i.id] = i;
    this.bank_types = {};
    for (const b of data.bank_types) this.bank_types[b.id] = b;
    this.cb_decisions = {};
    this.cb_list = data.cb_decisions;
    for (const c of data.cb_decisions) this.cb_decisions[c.round] = c;
    this.stress_scenarios = {};
    for (const s of data.stress_scenarios) this.stress_scenarios[s.id] = s;

    this._validate();
  }

  static load() {
    if (typeof CARDS === "undefined") {
      throw new Error("нет данных карточек (cards-data.js не подключён)");
    }
    return new CardDB(CARDS);
  }

  _validate() {
    const errors = [];
    for (const d of Object.values(this.deals)) {
      for (const key of ["id", "name", "sector", "kind", "body", "term", "income",
                         "payoff", "risk", "default_on", "default_penalty"]) {
        if (!(key in d)) errors.push(`сделка ${d.id || "?"}: нет поля ${key}`);
      }
      if (d.kind !== "A" && d.kind !== "B") {
        errors.push(`сделка ${d.id}: kind должен быть A или B`);
      }
      if (d.kind === "B" && (d.income || 0) !== 0) {
        errors.push(`сделка ${d.id}: тип Б не должен иметь доход по раундам`);
      }
    }
    for (let r = 1; r <= this.rounds; r++) {
      if (!(r in this.cb_decisions)) errors.push(`нет решения ЦБ для раунда ${r}`);
    }
    for (const fid of ["deposits", "mbk", "bonds", "penalty_credit"]) {
      if (!(fid in this.funding)) errors.push(`нет пассива ${fid}`);
    }
    if (!("base" in this.bank_types)) errors.push("нет базового типа банка");
    if (this.discount_cards.length !== 6) errors.push("карточек скидки должно быть 6");
    if (errors.length) {
      throw new Error("Ошибки в данных карточек:\n" + errors.join("\n"));
    }
  }

  freeDeals() {
    return Object.values(this.deals).filter((d) => !d.auction);
  }

  cbDecision(roundNumber, state) {
    if (state && state.cb_decisions && state.cb_decisions[roundNumber]) {
      return state.cb_decisions[roundNumber];
    }
    return this.cb_decisions[roundNumber];
  }

  mbkRate(roundNumber, activeStress, state) {
    const rnd = Math.min(roundNumber, this.rounds);
    let rate = this.cbDecision(rnd, state).mbk_rate ?? 2;
    if ((activeStress || []).includes("S3") && rnd === 6) {
      rate = this.stress_scenarios.S3.mbk_rate;
    }
    return rate;
  }
}

// ============ core.py: состояние партии ============

function dealFromDict(x) {
  return {
    uid: x.uid,
    card_id: x.card_id,
    column: x.column,
    discount: x.discount ?? 0,
    discount_used: !!x.discount_used,
  };
}

function fundingFromDict(x) {
  return {
    uid: x.uid,
    card_id: x.card_id,
    rounds_left: x.rounds_left ?? null,
    free_round: x.free_round ?? 0,
  };
}

class Team {
  constructor({
    name, capital, liquidity, bank_type = "base",
    deals = [], funding = [], improvements = [], bid_hand = [],
    reserve_used = false,
  }) {
    this.name = name;
    this.capital = capital;
    this.liquidity = liquidity;
    this.bank_type = bank_type;
    this.deals = deals;            // [{uid, card_id, column, discount, discount_used}]
    this.funding = funding;        // [{uid, card_id, rounds_left, free_round}]
    this.improvements = improvements;
    this.bid_hand = bid_hand;      // свободные карточки скидки
    this.reserve_used = reserve_used;
  }

  dealByUid(uid) {
    return this.deals.find((d) => d.uid === uid) || null;
  }

  fundingByUid(uid) {
    return this.funding.find((f) => f.uid === uid) || null;
  }

  hasImprovement(id) {
    return this.improvements.includes(id);
  }

  get hasPenaltyCredit() {
    return this.funding.some((f) => f.card_id === "penalty_credit");
  }

  get hasReserves() {
    return this.improvements.includes("reserve_fund") && !this.reserve_used;
  }

  toDict() {
    return {
      name: this.name,
      capital: this.capital,
      liquidity: this.liquidity,
      bank_type: this.bank_type,
      deals: this.deals.map((d) => ({ ...d })),
      funding: this.funding.map((f) => ({ ...f })),
      improvements: [...this.improvements],
      bid_hand: [...this.bid_hand],
      reserve_used: this.reserve_used,
    };
  }

  static fromDict(d) {
    return new Team({
      name: d.name,
      capital: d.capital,
      liquidity: d.liquidity,
      bank_type: d.bank_type,
      deals: (d.deals || []).map(dealFromDict),
      funding: (d.funding || []).map(fundingFromDict),
      improvements: [...(d.improvements || [])],
      bid_hand: [...(d.bid_hand || [])],
      reserve_used: !!d.reserve_used,
    });
  }
}

class GameState {
  constructor(d = {}) {
    this.teams = d.teams || [];
    this.round_number = d.round_number ?? 1;
    this.phase = d.phase || "round_start";
    this.deck = d.deck || [];
    this.discard = d.discard || [];
    this.market_lots = d.market_lots || [];
    this.active_stress = d.active_stress || [];
    this.pending_stress = d.pending_stress || [];
    this.free_pool = d.free_pool || {};
    this.deposit_free_used = d.deposit_free_used || {};
    this.next_uid = d.next_uid ?? 1;
    this.eliminated = d.eliminated || {};
    this.turn_team = d.turn_team ?? 0;
    this.pro_mixed = !!d.pro_mixed;
    this.scored = !!d.scored;
    this.log = d.log || [];
    this.cb_decisions = d.cb_decisions || {};
  }

  allocUid() {
    const uid = this.next_uid;
    this.next_uid += 1;
    return uid;
  }

  get finished() {
    return this.phase === "finished";
  }

  toDict() {
    return {
      teams: this.teams.map((t) => t.toDict()),
      round_number: this.round_number,
      phase: this.phase,
      deck: [...this.deck],
      discard: [...this.discard],
      market_lots: [...this.market_lots],
      active_stress: [...this.active_stress],
      pending_stress: [...this.pending_stress],
      free_pool: { ...this.free_pool },
      deposit_free_used: { ...this.deposit_free_used },
      next_uid: this.next_uid,
      eliminated: { ...this.eliminated },
      turn_team: this.turn_team,
      pro_mixed: this.pro_mixed,
      scored: this.scored,
      log: [...this.log],
      cb_decisions: JSON.parse(JSON.stringify(this.cb_decisions)),
    };
  }

  static fromDict(d) {
    return new GameState({
      teams: (d.teams || []).map((t) => Team.fromDict(t)),
      round_number: d.round_number,
      phase: d.phase,
      deck: [...(d.deck || [])],
      discard: [...(d.discard || [])],
      market_lots: [...(d.market_lots || [])],
      active_stress: [...(d.active_stress || [])],
      pending_stress: [...(d.pending_stress || [])],
      free_pool: { ...(d.free_pool || {}) },
      deposit_free_used: { ...(d.deposit_free_used || {}) },
      next_uid: d.next_uid,
      eliminated: { ...(d.eliminated || {}) },
      turn_team: d.turn_team,
      pro_mixed: d.pro_mixed,
      scored: d.scored,
      log: [...(d.log || [])],
      cb_decisions: d.cb_decisions || {},
    });
  }
}

// ============ производные правила (core.py) ============

/** Эффективный Риск сделки с учётом «ИИ-Скоринг». */
function dealRisk(team, deal, db) {
  const card = db.deals[deal.card_id];
  let risk = card.risk;
  if (team.hasImprovement("ai_scoring")) {
    const imp = db.improvements.ai_scoring;
    risk = Math.max(imp.min_risk, risk - imp.risk_reduction);
  }
  return risk;
}

function totalRisk(team, db) {
  return team.deals.reduce((sum, d) => sum + dealRisk(team, d, db), 0);
}

function riskLimit(team, db) {
  let limit = team.capital;
  if (team.hasImprovement("compliance")) {
    limit += db.improvements.compliance.risk_overcap;
  }
  return limit;
}

function canAddRisk(team, newRisk, db) {
  return totalRisk(team, db) + newRisk <= riskLimit(team, db);
}

function conveyorLimit(team, db) {
  return db.bank_types[team.bank_type].conveyor_limit;
}

function allowedDeal(team, card, db) {
  if (team.deals.some((d) => d.card_id === card.id)) return false;
  const bank = db.bank_types[team.bank_type];
  const pro = card.pro;
  if (pro && !(bank.pro || []).includes(pro)) return false;
  if ((pro === "kredity" || pro === "invest") && team.bank_type === "base") return false;
  const forbidden = bank.forbidden_deals || [];
  if (pro && forbidden.includes(pro)) return false;
  return true;
}

function monthlyCost(team, db) {
  return db.bank_types[team.bank_type].monthly_cost;
}

// ============ Создание партии (engine.py) ============

const FUNDING_SLOTS = 4;
// что можно вернуть в ЦБ на ШАГе 2 (info.md: Вклады и МБК; штрафной — по желанию)
const RETURNABLE_FUNDING = ["deposits", "mbk", "penalty_credit"];

function newGame(db, teamNames) {
  // имена команд приходят со стартового экрана (слайдер 2..6); без них — классика
  const names = (Array.isArray(teamNames) && teamNames.length)
    ? teamNames
    : ["Команда 1", "Команда 2"];
  const state = new GameState({ teams: [] });
  const used = new Set();
  names.forEach((raw, i) => {
    let name = String(raw || "").trim() || `Команда ${i + 1}`;
    let suffix = 2;
    while (used.has(name)) name = `${name} (${suffix++})`;
    used.add(name);
    state.teams.push(new Team({
      name,
      capital: db.starting_capital,
      liquidity: db.starting_liquidity,
      bid_hand: [...db.discount_cards],
    }));
  });

  for (const card of db.freeDeals()) {
    state.free_pool[card.id] = db.free_deal_copies;
  }

  const deck = [];
  for (const card of Object.values(db.deals)) {
    if (card.auction && !card.pro) {
      for (let i = 0; i < db.auction_deal_copies; i++) deck.push(card.id);
    }
  }
  shuffle(deck);
  state.deck = deck;

  const cbDecs = [...db.cb_list];
  shuffle(cbDecs);
  const cbMap = {};
  cbDecs.forEach((c, i) => {
    const roundNum = i + 1;
    cbMap[roundNum] = { ...c, round: roundNum };
  });
  state.cb_decisions = cbMap;

  state.phase = "round_start";
  state.round_number = 1;
  return state;
}

// ============ Игровая сессия ============

class Game {
  constructor(db, state, uiRef, onRoundEnd = null) {
    this.db = db;
    this.state = state;
    this.ui = uiRef;
    this.onRoundEnd = onRoundEnd;
  }

  // ------ служебные хелперы UI ------

  stepLabel(n) {
    const total = this.state.round_number === 5 ? 5 : 4;
    return `ШАГ ${n}/${total}`;
  }

  async infoBack(...msgs) {
    for (const m of msgs) this.ui.note(m);
    await this.ui.pause("Назад");
  }

  async confirmOrCancel(title, details) {
    if (!(await this.ui.confirm(title, details))) {
      this.ui.note("Отменено.");
      return false;
    }
    return true;
  }

  hasLiquidity(team, price) {
    if (team.liquidity < price) {
      this.ui.note(`Не хватает денег: нужно ${price}, есть ${team.liquidity}.`);
      return false;
    }
    return true;
  }

  /** Меню выбора с пунктом «Назад» -> выбранный payload или null. */
  async pick(prompt, options, backLabel = "Назад") {
    const opts = options.map(([label, value]) => ({ label, value }));
    opts.push({ label: backLabel, value: null });
    const idx = await this.ui.askChoice(prompt, opts);
    return opts[idx].value;
  }

  _opts(pairs) {
    return pairs.map(([label, value]) => ({ label, value }));
  }

  /** Экран хода команды: карточка команды → общий статус → варианты. */
  drawTeamTurn(team, extra) {
    const ui = this.ui;
    ui.clear();
    ui.header(this.state, this.db, extra);
    ui.showTable(team, this.state, this.db);
    ui.showStatus(this.state, this.db);
  }

  // ------ колода ------

  mixProCards() {
    const s = this.state;
    if (s.pro_mixed) return;
    for (const card of Object.values(this.db.deals)) {
      if (card.auction && card.pro) {
        for (let i = 0; i < this.db.pro_deal_copies; i++) s.deck.push(card.id);
      }
    }
    shuffle(s.deck);
    s.pro_mixed = true;
  }

  draw() {
    const s = this.state;
    if (!s.deck.length && s.discard.length) {
      s.deck = [...s.discard];
      s.discard = [];
      shuffle(s.deck);
      this.ui.log("Колода пуста — сброс перемешан заново.", s);
    }
    if (!s.deck.length) return null;
    return s.deck.shift();
  }

  // ------ главный цикл ------

  async runLoop() {
    const handlers = {
      round_start: () => this.phaseRoundStart(),
      funding: () => this.phaseFunding(),
      auction_lots: () => this.phaseAuctionLot(),
      auction_free: () => this.phaseFreeTake(),
      settlement: () => this.phaseSettlement(),
      stress: () => this.phaseStress(),
      round_end: () => this.phaseRoundEnd(),
    };
    while (!this.state.finished) {
      const handler = handlers[this.state.phase];
      if (!handler) break;
      await handler();
    }
  }

  // ====== ШАГ 1: решение ЦБ и выкладка сделок ======

  async phaseRoundStart() {
    const s = this.state, db = this.db, ui = this.ui;
    if (this.onRoundEnd) this.onRoundEnd(s); // автосохранение в начале раунда
    ui.clear();
    const dec = db.cbDecision(s.round_number);
    ui.header(s, db, `${this.stepLabel(1)} — Решение ЦБ и сделки на рынке`);
    ui.note(dec.text);

    if (s.round_number === 2) {
      this.mixProCards();
      ui.log("В колоду подмешаны сделки [PRO] (Уровень 2).", s);
    }

    if (s.round_number === 6) await this.applyStressAtRoundStart();

    const lots = s.teams.length + db.auction_lots_extra;
    s.market_lots = [];
    for (let i = 0; i < lots; i++) {
      const cid = this.draw();
      if (cid) s.market_lots.push(cid);
    }

    ui.showMarket(s, db);
    ui.showStatus(s, db);
    ui.note("На торгах каждая команда тайно кладёт карточку скидки: "
      + "большая скидка повышает шанс забрать сделку, но уменьшает доход.");
    await ui.pause();

    s.phase = "funding";
    s.turn_team = 0;
  }

  async applyStressAtRoundStart() {
    const s = this.state, db = this.db, ui = this.ui;
    for (const sid of s.active_stress) {
      const st = db.stress_scenarios[sid];
      if (sid === "S2") {
        for (const t of s.teams) {
          const n = t.funding.filter((f) => f.card_id === "deposits").length;
          if (n && t.hasImprovement(st.waived_by)) {
            ui.log(`${t.name}: вклады защищены «Мобильным Приложением», набег обошёлся.`, s);
          } else if (n) {
            this.pay(t, n * st.deposit_penalty);
            ui.log(`${t.name}: набег вкладчиков — ${n} вкладов × `
              + `${st.deposit_penalty} = ${n * st.deposit_penalty} очков в ЦБ.`, s);
          }
        }
      }
      if (sid === "S1") {
        for (const t of s.teams) {
          const cons = t.deals.filter((d) => db.deals[d.card_id].sector === "Стройка");
          if (cons.length >= st.concentration_cards) {
            deductCapital(t, st.concentration_penalty);
            ui.log(`${t.name}: ${cons.length} карты Стройки — опасная концентрация, `
              + `списано ${st.concentration_penalty} Капитала.`, s);
          }
        }
      }
    }
    if (s.active_stress.length) await ui.pause();
  }

  // ====== ШАГ 2: долги и покупки ======

  fundingDetails(fid) {
    const s = this.state, db = this.db;
    const c = db.funding[fid];
    const rate = db.mbkRate(s.round_number, s.active_stress);
    const per = c.per_round;
    const perTxt = per === "key_rate" ? `${rate} (по ставке ЦБ)` : String(per);
    const lines = [
      `+${c.liquidity} очков сейчас в кассу`,
      `платёж ${perTxt} очков каждый раунд`,
    ];
    if (fid === "deposits") {
      lines.push("вернуть в ЦБ можно в любой момент, отдав 10 очков");
    } else if (fid === "mbk") {
      lines.push("можно вернуть досрочно (отдать 10) или в конце раунда "
        + "продлить, заплатив ставку");
    } else if (fid === "bonds") {
      lines.push("остаётся 3 раунда, раньше вернуть нельзя");
    } else if (fid === "penalty_credit") {
      lines.push("дорогой долг: пока он есть — нельзя покупать улучшения");
    }
    const dec = db.cbDecision(Math.min(s.round_number, db.rounds));
    lines.push(`решение ЦБ этого раунда: «${dec.title}» — ${dec.text || ""}`);
    if (fid === "deposits" && dec.free_first_deposit) {
      lines.push("по решению ЦБ первая взятая карта вкладов в этом раунде "
        + "обслуживается бесплатно");
    }
    return lines;
  }

  async phaseFunding() {
    const s = this.state, ui = this.ui;
    if (s.turn_team >= s.teams.length) {
      s.phase = "auction_lots";
      s.turn_team = 0;
      return;
    }

    const team = s.teams[s.turn_team];
    this.drawTeamTurn(team, `${this.stepLabel(2)} — Долги и покупки в ЦБ`);
    const tabs = [
      ["Взять — новый долг у ЦБ (плюс денег сейчас, платёж каждый раунд)", "tab_take"],
      ["Купить — Улучшение или новую специализацию банка", "tab_buy"],
    ];
    if (team.funding.some((f) => RETURNABLE_FUNDING.includes(f.card_id))) {
      tabs.push(["Вернуть долг в ЦБ", "tab_return"]);
    }
    tabs.push(["Завершить ход — дальше", "do_done"]);
    const idx = await ui.askChoice(`Что делаем`, this._opts(tabs));
    const tab = tabs[idx][1];

    if (tab === "tab_take") await this.fundingTake(team);
    else if (tab === "tab_buy") await this.fundingBuy(team);
    else if (tab === "tab_return") await this.fundingReturn(team);
    else if (tab === "do_done") {
      if (await ui.askYesNo(`Завершить ход ${team.name}?`, true)) s.turn_team += 1;
    }
  }

  async fundingTake(team) {
    const s = this.state, db = this.db, ui = this.ui;
    const options = [];
    if (team.funding.length < FUNDING_SLOTS) {
      const bank = db.bank_types[team.bank_type];
      for (const fid of Object.keys(db.funding)) {
        const f = db.funding[fid];
        if (f.forced) continue;
        if ((bank.forbidden_funding || []).includes(fid)) continue;
        const rate = db.mbkRate(s.round_number, s.active_stress);
        const per = cPerTxt(f, rate);
        options.push([`${f.name} — +${f.liquidity} сейчас, платёж ${per}/р.`, fid]);
      }
    }
    if (!options.length) {
      await this.infoBack("Брать нечего: либо слоты долгов заняты, либо банк не позволяет.");
      return;
    }
    const fid = await this.pick("Что взять у ЦБ", options);
    if (fid === null) return;

    const c = db.funding[fid];
    if (!(await this.confirmOrCancel(`Взять «${c.name}»?`, this.fundingDetails(fid)))) return;

    let freeRound = 0;
    if (fid === "deposits"
        && db.cbDecision(s.round_number).free_first_deposit
        && !(s.deposit_free_used[team.name])) {
      freeRound = s.round_number;
      s.deposit_free_used[team.name] = true;
    }
    const inst = {
      uid: s.allocUid(),
      card_id: fid,
      rounds_left: c.term ?? null,
      free_round: freeRound,
    };
    team.funding.push(inst);
    team.liquidity += c.liquidity;
    const freeTxt = freeRound ? " (в этом раунде обслуживание бесплатное)" : "";
    ui.log(`${team.name}: взял «${c.name}» → +${c.liquidity} очков${freeTxt}.`, s);
  }

  async fundingBuy(team) {
    const s = this.state, db = this.db, ui = this.ui;
    const options = [];
    if (s.round_number >= db.bank_types.commercial.min_round && team.bank_type === "base") {
      for (const bid of ["commercial", "investment", "ecosystem"]) {
        const b = db.bank_types[bid];
        options.push([`Специализация «${b.name}» — ${b.price} очков`, ["spec", bid]]);
      }
    }
    if (team.improvements.length < 3 && !team.hasPenaltyCredit) {
      for (const [iid, imp] of Object.entries(db.improvements)) {
        if (team.improvements.includes(iid)) continue;
        options.push([`Улучшение «${imp.name}» — ${imp.price} очков`, ["imp", iid]]);
      }
    }
    if (!options.length) {
      await this.infoBack("Покупать нечего (или запрещено штрафным кредитом ЦБ).");
      return;
    }
    const picked = await this.pick("Что купить", options);
    if (picked === null) return;
    const [action, payload] = picked;

    if (action === "spec") {
      const b = db.bank_types[payload];
      const details = [
        `цена: ${b.price} очков ликвидности`,
        b.note || "",
        `слабое место: ${b.weak || "—"}`,
        "меняется один раз за игру",
      ];
      if (!(await this.confirmOrCancel(`Стать банком «${b.name}»?`, details))) return;
      if (!this.hasLiquidity(team, b.price)) return;
      team.liquidity -= b.price;
      team.bank_type = payload;
      ui.log(`${team.name}: специализация «${b.name}» (−${b.price}).`, s);
    } else if (action === "imp") {
      const imp = db.improvements[payload];
      const details = [`цена: ${imp.price} очков ликвидности`, imp.note || ""];
      if (!(await this.confirmOrCancel(`Купить «${imp.name}»?`, details))) return;
      if (!this.hasLiquidity(team, imp.price)) return;
      team.liquidity -= imp.price;
      team.improvements.push(payload);
      ui.log(`${team.name}: куплено улучшение «${imp.name}» (−${imp.price}).`, s);
    }
  }

  async fundingReturn(team) {
    /** Возврат долгов в ЦБ — вклады, МБК и штрафные кредиты (info.md, ШАГ 2). */
    const s = this.state, db = this.db, ui = this.ui;
    const options = [];
    for (const f of team.funding) {
      if (RETURNABLE_FUNDING.includes(f.card_id)) {
        const c = db.funding[f.card_id];
        options.push([`Вернуть «${c.name}» в ЦБ (отдать ${c.liquidity})`, f.uid]);
      }
    }
    if (!options.length) {
      await this.infoBack("Возвращать нечего.");
      return;
    }
    const uid = await this.pick("Что вернуть в ЦБ", options);
    if (uid === null) return;

    const inst = team.fundingByUid(uid);
    if (!inst) {
      this.ui.note("Карта не найдена.");
      return;
    }
    const c = db.funding[inst.card_id];
    const details = [
      `отдать нужно ${c.liquidity} очков`,
      "карта уходит из списка долгов, платёж по ней прекращается",
    ];
    if (!(await this.confirmOrCancel(`Вернуть «${c.name}» в ЦБ?`, details))) return;
    if (!this.hasLiquidity(team, c.liquidity)) return;
    team.liquidity -= c.liquidity;
    const i = team.funding.indexOf(inst);
    if (i >= 0) team.funding.splice(i, 1);
    ui.log(`${team.name}: вернул «${c.name}» в ЦБ (−${c.liquidity}).`, s);
  }

  // ====== ШАГ 3: гласный аукцион (тайные ставки) ======

  async phaseAuctionLot() {
    const s = this.state, db = this.db, ui = this.ui;
    if (!s.market_lots.length) {
      s.phase = "auction_free";
      s.turn_team = 0;
      return;
    }

    const cid = s.market_lots[0];
    const card = db.deals[cid];
    const net = dealNet(card);

    const lotBanner = (extra = null) => {
      ui.clear();
      ui.header(s, db, `${this.stepLabel(3)} — Тайная ставка за сделку`);
      ui.clearNotes();
      ui.note(`Торгуется: ${card.name} — вложить ${card.body}, ${kindStr(card)}, `
        + `риск ${card.risk} (чистый доход +${net})`);
      const req = proRequirement(card, db);
      if (req) ui.note(`Только для: ${req}`);
      if (extra) ui.note(extra);
    };

    // тайные ставки
    const bids = []; // {team, bid|null, reason|null}
    for (const team of s.teams) {
      let reason = this.bidRejectionReason(team, card);
      if (!reason && !team.bid_hand.length) reason = "нет свободных карточек скидки";
      lotBanner(reason ? `Статус ${team.name}: ${reason}` : null);
      ui.showTable(team, s, db);
      if (reason) {
        bids.push({ team, bid: null, reason });
        continue;
      }
      if (await ui.askYesNo(`${team.name}: участвует в торгах за «${card.name}»?`, false)) {
        const opts = [...team.bid_hand].sort((a, b) => a - b).map((v) => ({
          label: `карточка скидки ${v} → получите +${net + v} вместо +${net}`,
          value: v,
        }));
        const idx = await ui.askChoice(`${team.name}: какую карточку скидку поставить?`, opts);
        const bid = opts[idx].value;
        const hi = team.bid_hand.indexOf(bid);
        if (hi >= 0) team.bid_hand.splice(hi, 1);
        bids.push({ team, bid, reason: null });
      } else {
        bids.push({ team, bid: null, reason: null });
      }
    }

    // вскрытие: одинаковые статусы группируем, без повторов
    lotBanner("ВСКРЫТИЕ СТАВОК — кто победил?");
    const groups = {};
    const order = [];
    for (const b of bids) {
      let key;
      if (b.bid !== null) key = `ставка ${b.bid}`;
      else key = b.reason ? `пас — ${b.reason}` : "пас";
      if (!(key in groups)) {
        groups[key] = [];
        order.push(key);
      }
      groups[key].push(b.team.name);
    }
    for (const key of order) ui.note(`${groups[key].join(", ")}: ${key}`);

    const contenders = bids.filter((b) => b.bid !== null).map((b) => [b.team, b.bid]);
    if (!contenders.length) {
      ui.log(`За лот «${card.name}» никто не боролся — карта уходит в сброс.`, s);
      s.discard.push(cid);
      s.market_lots.shift();
      await ui.pause();
      return;
    }

    // победитель: самая большая скидка, ничья → меньше Риск → кубик
    contenders.sort((a, b) => (a[1] - b[1]) || (totalRisk(a[0], db) - totalRisk(b[0], db)));
    let winner = contenders[0][0];
    let winBid = contenders[0][1];
    let ties = contenders.filter((c) => c[1] === winBid);
    if (ties.length > 1) {
      const minRisk = Math.min(...ties.map((c) => totalRisk(c[0], db)));
      ties = ties.filter((c) => totalRisk(c[0], db) === minRisk);
    }
    if (ties.length > 1) {
      ui.note("Полная ничья — кубик решает!");
      const roll = await ui.throwDice();
      const pair = roll % 2 ? ties[0] : ties[1];
      winner = pair[0];
      winBid = pair[1];
    }

    for (const b of bids) {
      if (b.bid !== null && b.team !== winner) b.team.bid_hand.push(b.bid);
    }

    this.takeDeal(winner, cid, winBid);
    ui.log(`${winner.name} побеждает в торгах за «${card.name}» со скидкой ${winBid}!`, s);
    s.market_lots.shift();
    await ui.pause();
  }

  bidRejectionReason(team, card) {
    const db = this.db;
    if (team.deals.some((d) => d.card_id === card.id)) return "такая сделка уже есть у команды";
    if (!allowedDeal(team, card, db)) return "сделка недоступна по Типу Банка";
    if (team.deals.length >= conveyorLimit(team, db)) {
      return `мест для сделок уже занято (${conveyorLimit(team, db)})`;
    }
    const price = this.dealPrice(team, card);
    if (team.liquidity < price) {
      return `не хватает Ликвидности (нужно ${price}, есть ${team.liquidity})`;
    }
    if (!canAddRisk(team, card.risk, db)) {
      return `норматив ЦБ: Риск ${totalRisk(team, db)} + ${card.risk} > предел ${riskLimit(team, db)}`;
    }
    return null;
  }

  dealPrice(team, card) {
    let price = card.body;
    const bank = this.db.bank_types[team.bank_type];
    if (card.pro === "invest") price -= bank.invest_body_discount || 0;
    return Math.max(0, price);
  }

  takeDeal(team, cid, bid) {
    /** Карточка скидки уже списана с руки в момент тайной ставки. */
    const s = this.state, db = this.db, ui = this.ui;
    const card = db.deals[cid];
    const price = this.dealPrice(team, card);
    team.liquidity -= price;
    if (price !== card.body) {
      ui.log(`${team.name}: комиссия организатора — тело ${card.body} со скидкой `
        + `${card.body - price}, уплачено ${price}.`, s);
    }
    const inst = {
      uid: s.allocUid(),
      card_id: cid,
      column: Math.min(3, Math.max(1, card.term)),
      discount: bid,
      discount_used: false,
    };
    team.deals.push(inst);
    ui.log(`${team.name}: сделка «${card.name}» взята, осталось ${card.term} р., `
      + `уплачено ${price}, риск +${card.risk}.`, s);
  }

  // ====== ШАГ 3б: бесплатные сделки у ЦБ ======

  async phaseFreeTake() {
    const s = this.state, ui = this.ui;
    if (s.turn_team >= s.teams.length) {
      s.phase = "settlement";
      return;
    }

    const team = s.teams[s.turn_team];
    this.drawTeamTurn(team, `${this.stepLabel(3)} — Бесплатные сделки у ЦБ (без торгов)`);
    // статусы доступности — прямо под карточкой команды
    for (const [cid, count] of Object.entries(s.free_pool)) {
      if (count <= 0) continue;
      const card = this.db.deals[cid];
      const reason = this.freeTakeReason(team, card);
      if (reason) this.ui.note(`«${card.name}» — ${reason}`);
    }
    if (!Object.values(s.free_pool).some((n) => n > 0)) {
      this.ui.note("Пул бесплатных сделок пуст.");
    }
    const tabs = [
      ["Взять бесплатную сделку у ЦБ", "tab_take"],
      ["Завершить ход — дальше", "do_done"],
    ];
    const idx = await ui.askChoice(`Ход ${team.name}: что делаем`, this._opts(tabs));
    const tab = tabs[idx][1];

    if (tab === "do_done") {
      if (await ui.askYesNo(`Завершить ход ${team.name}?`, true)) s.turn_team += 1;
      return;
    }

    await this.freeTakePick(team);
  }

  freeTakeReason(team, card) {
    /** Почему команде нельзя взять бесплатную сделку (или null — можно). */
    const s = this.state, db = this.db;
    if (team.deals.some((d) => d.card_id === card.id)) return "такая сделка уже есть у команды";
    if (!allowedDeal(team, card, db)) return "сделка недоступна по Типу Банка";
    if (team.deals.length >= conveyorLimit(team, db)) {
      return `конвейер заполнен (${conveyorLimit(team, db)} сделок)`;
    }
    const price = this.dealPrice(team, card);
    if (team.liquidity < price) return `не хватает денег (нужно ${price}, есть ${team.liquidity})`;
    if (!canAddRisk(team, card.risk, db)) {
      return `не хватает запаса по Риску (${totalRisk(team, db)} + ${card.risk} > ${riskLimit(team, db)})`;
    }
    return null;
  }

  async freeTakePick(team) {
    /** Меню выбора бесплатной сделки; если брать нечего — экран с пояснениями. */
    const s = this.state, db = this.db, ui = this.ui;
    const options = [];
    const reasons = [];
    for (const [cid, count] of Object.entries(s.free_pool)) {
      if (count <= 0) continue;
      const card = db.deals[cid];
      const reason = this.freeTakeReason(team, card);
      if (reason) {
        reasons.push(`«${card.name}»: ${reason}.`);
        continue;
      }
      const price = this.dealPrice(team, card);
      options.push([`${card.name} — уплатить ${price}`, cid]);
    }
    if (!options.length) {
      await this.infoBack(...reasons, "Взять нечего.");
      return;
    }
    const cid = await this.pick("Какую сделку взять", options);
    if (cid === null) return;

    const card = db.deals[cid];
    const price = this.dealPrice(team, card);
    const net = dealNet(card);
    const details = [
      `заплатить сейчас: ${price} очков`,
      `чистый доход +${net}`,
      `срок: ${card.term} р.`,
      kindStr(card),
      `риск ${card.risk} очков (проверка кубиком в конце срока)`,
    ];
    if (!(await this.confirmOrCancel(`Взять «${card.name}»?`, details))) return;

    s.free_pool[cid] -= 1;
    const inst = {
      uid: s.allocUid(),
      card_id: cid,
      column: Math.min(3, Math.max(1, card.term)),
      discount: 0,
      discount_used: false,
    };
    team.liquidity -= price;
    team.deals.push(inst);
    ui.log(`${team.name}: взял у ЦБ «${card.name}» за ${price} `
      + `(осталось ${card.term} р.).`, s);
  }

  // ====== ШАГ 4: расчёты, кубик, сдвиг конвейера ======

  async phaseSettlement() {
    const s = this.state, db = this.db, ui = this.ui;
    ui.clear();
    ui.header(s, db, `${this.stepLabel(4)} — Платежи, доходы, кубик и сдвиг сделок`);

    for (const t of s.teams) {
      const need = monthlyCost(t, db);
      ui.log(`${t.name}: обязательный расход по Типу Банка = ${need}.`, s);
      this.pay(t, need);
    }

    for (const t of s.teams) {
      for (const f of [...t.funding]) {
        const c = db.funding[f.card_id];
        const per = c.per_round;
        let amount = per === "key_rate" ? db.mbkRate(s.round_number, s.active_stress) : per;
        const bank = db.bank_types[t.bank_type];
        if (f.card_id === "deposits") {
          amount = bank.deposit_cost ?? per;
          if (f.free_round === s.round_number) amount = 0;
        }
        if (amount === 0) {
          ui.log(`${t.name}: «${c.name}» обслуживается бесплатно в этом раунде.`, s);
          continue;
        }
        ui.log(`${t.name}: платёж по «${c.name}» = ${amount}.`, s);
        this.pay(t, amount);
      }
    }

    for (const t of s.teams) {
      for (let d of [...t.deals]) {
        const card = db.deals[d.card_id];
        if (card.kind !== "A") continue;
        let amount = card.income;
        const dec = db.cbDecision(s.round_number);
        if (card.id === "free_ofz" && "ofz_bonus" in dec) amount = dec.ofz_bonus;
        if (dec.subsidy_sectors && dec.subsidy_sectors.includes(card.sector)) {
          amount += dec.subsidy_amount;
          ui.log(`${t.name}: субсидия ЦБ за сектор ${card.sector} +${dec.subsidy_amount}.`, s);
        }
        if (!d.discount_used) {
          amount += d.discount;
          d = this.applyDiscount(t, d);
        }
        t.liquidity += Math.max(0, amount);
        ui.log(`${t.name}: доход по «${card.name}» = ${Math.max(0, amount)}.`, s);
      }
    }

    for (const t of s.teams) {
      const bank = db.bank_types[t.bank_type];
      if (bank.per_deal_income) {
        const bonus = bank.per_deal_income * t.deals.length;
        if (bonus) {
          t.liquidity += bonus;
          ui.log(`${t.name}: доход экосистемы +${bonus} (за ${t.deals.length} сделок).`, s);
        }
      }
      if (t.hasImprovement("mobile_app")) {
        t.liquidity += 1;
        ui.log(`${t.name}: «Мобильное Приложение» +1.`, s);
      }
    }

    ui.clear();
    ui.header(s, db, `${this.stepLabel(4)} — Проверка сделок кубиком (конец срока)`);
    for (const t of s.teams) {
      for (const d of [...t.deals]) {
        if (d.column === 1) await this.closeDeal(t, d);
      }
    }

    for (const t of s.teams) {
      for (const d of t.deals) {
        if (d.column > 1) d.column -= 1;
      }
      if (t.deals.length) {
        ui.log(`${t.name}: сделки подвинулись → ` + t.deals
          .map((x) => `${db.deals[x.card_id].name} (осталось ${x.column} р.)`)
          .join(", "), s);
      }
    }

    for (const t of s.teams) {
      for (const f of [...t.funding]) {
        if (f.card_id === "mbk") {
          await this.resolveMbk(t, f);
        } else if (f.card_id === "bonds" && f.rounds_left !== null && f.rounds_left !== undefined) {
          f.rounds_left -= 1;
          if (f.rounds_left <= 0) await this.repayFunding(t, f);
        }
      }
    }

    for (const t of s.teams) await this.capitalExchange(t);

    const dec = db.cbDecision(s.round_number);
    if ("revision_min_gap" in dec) {
      for (const t of s.teams) {
        const gap = t.capital - totalRisk(t, db);
        if (gap < dec.revision_min_gap) {
          ui.log(`${t.name}: запас Риск↔Капитал = ${gap} < ${dec.revision_min_gap} — `
            + `предписание, платит ${dec.revision_penalty}.`, s);
          this.pay(t, dec.revision_penalty);
        }
      }
    }

    ui.showStatus(s, db);
    ui.log(`Раунд ${s.round_number} завершён.`, s);
    await ui.pause();

    s.phase = s.round_number === 5 ? "stress" : "round_end";
  }

  applyDiscount(team, deal) {
    /** Снимает карточку скидки со сделки и возвращает её в руку команды. */
    const fresh = { ...deal, discount_used: true };
    team.deals = team.deals.map((x) => (x.uid === deal.uid ? fresh : x));
    if (!team.bid_hand.includes(deal.discount)) team.bid_hand.push(deal.discount);
    return fresh;
  }

  async resolveMbk(team, inst) {
    const s = this.state, db = this.db, ui = this.ui;
    const rate = db.mbkRate(s.round_number, s.active_stress);
    this.drawTeamTurn(team, `${this.stepLabel(4)} — Займ МБК (${team.name})`);
    ui.note(`«${team.name}», МБК: продлить (платёж ${rate}) или вернуть 10 очков?`);
    const options = [["Продлить МБК", "extend"], ["Вернуть 10 очков", "return"]];
    const idx = await ui.askChoice("МБК: что делаем", this._opts(options));
    const act = options[idx][1];
    if (act === "extend") {
      this.pay(team, rate);
      ui.log(`${team.name}: МБК продлен за ${rate}.`, s);
    } else {
      if (team.liquidity < 10) {
        ui.log(`${team.name}: не хватает на возврат МБК — недостающее списано.`, s);
      }
      await this.repayFunding(team, inst);
    }
  }

  async repayFunding(team, inst) {
    const s = this.state, db = this.db, ui = this.ui;
    const c = db.funding[inst.card_id];
    const need = c.liquidity;
    this.pay(team, need);
    const i = team.funding.indexOf(inst);
    if (i >= 0) team.funding.splice(i, 1);
    ui.log(`${team.name}: «${c.name}» погашен (−${need}).`, s);
  }

  async capitalExchange(team) {
    const s = this.state, db = this.db, ui = this.ui;
    const rate = db.capital_exchange_rate;
    const maxPairs = Math.floor(team.liquidity / rate);
    if (maxPairs <= 0) return;
    this.drawTeamTurn(team, `${this.stepLabel(4)} — Обмен прибыли на Капитал (${team.name})`);
    ui.note(`Ликвидность: ${team.liquidity} | Капитал: ${team.capital} | `
      + `${rate} ликвидности → 1 капитал, доступно пар: ${maxPairs}`);
    const act = await this.pick("Обмен прибыли на Капитал", [
      ["Обменять прибыль на Капитал", "yes"],
    ]);
    if (act !== "yes") return;
    const pairs = await ui.askInt(`Сколько обменять (${rate} ликвидности → 1 капитал)`, 1, maxPairs);
    const cost = Math.min(pairs * rate, Math.floor(team.liquidity / rate) * rate);
    const pairsGot = cost / rate;
    if (!(await this.confirmOrCancel(`Обменять ${cost} Ликвидности на ${pairsGot} Капитала?`, [
      `курс: ${rate} ликвидности → 1 капитал`,
      `после обмена: ликвидность ${team.liquidity - cost}, капитал ${team.capital + pairsGot}`,
    ]))) return;
    team.liquidity -= cost;
    team.capital += pairsGot;
    ui.log(`${team.name}: обменял ${cost} Ликвидности на ${pairsGot} Капитала.`, s);
  }

  // ====== деньги ======

  pay(team, amount) {
    /** Уплата в ЦБ: при нехватке — штрафной кредит, в последнюю очередь — Капитал. */
    const s = this.state, db = this.db, ui = this.ui;
    if (amount <= 0) return;
    if (team.liquidity >= amount) {
      team.liquidity -= amount;
      return;
    }
    let guard = 0;
    while (team.liquidity < amount && guard < 5) {
      guard += 1;
      const inst = this.penaltyFunding(team);
      if (!inst) break;
      team.funding.push(inst);
      team.liquidity += db.funding.penalty_credit.liquidity;
      ui.log(`${team.name}: НЕХВАТКА! ЦБ выдал «Штрафной кредит ЦБ» → +10 очков `
        + "(ставка 4/р., блокирует покупку Улучшений).", s);
    }
    if (team.liquidity >= amount) {
      team.liquidity -= amount;
      return;
    }
    const short = amount - team.liquidity;
    team.liquidity = 0;
    deductCapital(team, short);
    ui.log(`${team.name}: ликвидности нет — ${short} списано из Капитала 1:1.`, s);
  }

  penaltyFunding(team) {
    const count = team.funding.filter((f) => f.card_id === "penalty_credit").length;
    if (count >= 3 || team.funding.length >= FUNDING_SLOTS) return null;
    return { uid: this.state.allocUid(), card_id: "penalty_credit", rounds_left: null, free_round: 0 };
  }

  // ====== закрытие сделок ======

  async closeDeal(team, deal) {
    const s = this.state, db = this.db, ui = this.ui;
    const card = db.deals[deal.card_id];
    let failNumbers = new Set(card.default_on);
    if (s.active_stress.includes("S1") && card.sector === "Стройка") {
      const st = db.stress_scenarios.S1;
      failNumbers = new Set();
      for (let i = 1; i <= st.construction_fail; i++) failNumbers.add(i);
    }
    ui.clear();
    ui.header(s, db, `${this.stepLabel(4)} — Проверка: «${card.name}» (${team.name})`);
    const sortedFail = [...failNumbers].sort((a, b) => a - b);
    const failTxt = sortedFail.length ? `[${sortedFail.join(", ")}]` : "—";
    ui.note(`Бросок кубика: дефолт на ${failTxt} (штраф -${card.default_penalty} Капитала).`);
    const roll = await ui.throwDice();
    const failed = failNumbers.has(roll);
    ui.note(failed
      ? `Кубик ${roll} — ДЕФОЛТ по «${card.name}»!`
      : `Кубик ${roll} — успех, сделка закрывается.`);
    await ui.pause("Далее");

    if (!failed) {
      ui.log(`${team.name}: «${card.name}» — успех (кубик ${roll})!`, s);
      await this.finishClose(team, deal, true);
      return;
    }

    ui.log(`${team.name}: «${card.name}» — ДЕФОЛТ! (кубик ${roll})`, s);
    if (team.hasReserves) {
      ui.clear();
      ui.header(s, db, `${this.stepLabel(4)} — Спасение «Резервным Фондом»`);
      ui.note(`${team.name}: «${card.name}» — ДЕФОЛТ (кубик ${roll}).`);
      ui.note(`Штраф по карте: -${card.default_penalty} Капитала.`);
      if (await ui.askYesNo(`${team.name}: сбросить карту «Резервный Фонд» вместо штрафа?`, true)) {
        team.improvements = team.improvements.filter((x) => x !== "reserve_fund");
        team.reserve_used = true;
        ui.log(`${team.name}: «Резервный Фонд» спас от штрафа по «${card.name}».`, s);
        await this.finishClose(team, deal, true);
        return;
      }
    }
    const penalty = card.default_penalty;
    deductCapital(team, penalty);
    ui.log(`${team.name}: дефолт по «${card.name}» (кубик ${roll}), `
      + `списано ${penalty} Капитала.`, s);
    if (card.kind === "B") ui.log(`${team.name}: доход по «${card.name}» = 0.`, s);
    await this.finishClose(team, deal, false);
  }

  async finishClose(team, deal, success) {
    const s = this.state, db = this.db, ui = this.ui;
    const card = db.deals[deal.card_id];
    let paid = card.body;
    if (card.pro === "invest") {
      const bonus = db.bank_types[team.bank_type].invest_close_bonus ?? 0;
      paid += bonus;
      if (bonus) ui.log(`${team.name}: комиссия организатора при закрытии +${bonus}.`, s);
    }

    let income = 0;
    if (success && card.kind === "B") {
      income = card.payoff;
      if (!deal.discount_used) {
        income = Math.max(0, income + deal.discount);
        deal.discount_used = true;
      }
      if (card.pro === "invest" && s.round_number === 6 && s.active_stress.includes("S3")) {
        const penalty = db.stress_scenarios.S3.invest_income_penalty;
        income = Math.max(0, income - penalty);
        ui.log(`${team.name}: стресс «Кризис ликвидности» — куш по `
          + `«${card.name}» уменьшен на ${penalty}.`, s);
      }
    }

    team.liquidity += paid + income;
    if (income) {
      ui.log(`${team.name}: «${card.name}» — тело ${paid} + куш ${income} возвращено.`, s);
    } else {
      ui.log(`${team.name}: «${card.name}» — тело ${paid} возвращено.`, s);
    }

    if (!team.bid_hand.includes(deal.discount)) team.bid_hand.push(deal.discount);
    team.deals = team.deals.filter((d) => d.uid !== deal.uid);
    s.discard.push(card.id);
  }

  // ====== ШАГ 5: стресс-тест и межбанковская торговля ======

  async phaseStress() {
    const s = this.state, db = this.db, ui = this.ui;
    ui.clear();
    ui.header(s, db, `${this.stepLabel(5)} — Стресс-тест и торговля между командами`);

    if (!s.pending_stress.length) {
      const ids = Object.keys(db.stress_scenarios);
      shuffle(ids);
      s.pending_stress = ids.slice(0, 2).sort();
      ui.note("Ведущий вскрывает 2 из 3 карт Стресс-сценариев:");
      for (const sid of s.pending_stress) {
        const st = db.stress_scenarios[sid];
        ui.note(`«${st.name}» — ${st.text}`);
      }
      ui.note("В 6-м раунде сработает ОДНА из этих угроз (выбор — жребием).");
      while (await ui.askYesNo("Провести межбанковскую сделку сейчас?", false)) {
        if (!(await this.interbankDeal())) break;
      }
      ui.showStatus(s, db);
      await ui.pause();
    }
    s.phase = "round_end";
  }

  async interbankDeal() {
    /** Одна продажа сделки другой команде. False — сделок нет. */
    const s = this.state, db = this.db, ui = this.ui;
    if (!s.teams.some((t) => t.deals.length)) {
      ui.note("Нет сделок для межбанковской торговли.");
      return false;
    }

    let seller, buyer;
    if (s.teams.length === 2) {
      // классика на две команды: продавец тот, у кого есть сделки
      seller = s.teams[0];
      buyer = s.teams[1];
      if (!seller.deals.length) {
        const tmp = seller;
        seller = buyer;
        buyer = tmp;
      }
    } else {
      // 3+ команды: сами выбираем, кто продаёт и кто покупает
      const sellOpts = s.teams
        .filter((t) => t.deals.length)
        .map((t) => [`${t.name} (сделок: ${t.deals.length})`, t.name]);
      const sellName = await this.pick("Кто продаёт сделку?", sellOpts);
      if (sellName === null) return false;
      seller = s.teams.find((t) => t.name === sellName);

      const buyOpts = s.teams
        .filter((t) => t.name !== seller.name)
        .map((t) => [`${t.name} (ликвидность: ${t.liquidity})`, t.name]);
      const buyName = await this.pick(`Кто покупает у «${seller.name}»?`, buyOpts);
      if (buyName === null) return false;
      buyer = s.teams.find((t) => t.name === buyName);
    }

    ui.clear();
    ui.header(s, db, `${this.stepLabel(5)} — Сделка между командами`);
    ui.note(`Продавец: ${seller.name}, покупатель: ${buyer.name}`);
    const options = seller.deals.map((d) => [
      `${db.deals[d.card_id].name} (риск ${db.deals[d.card_id].risk}, осталось ${d.column} р.)`,
      d.uid,
    ]);
    const uid = await this.pick("Какую сделку продать", options);
    if (uid === null) return false;
    const deal = seller.dealByUid(uid);
    let price = await ui.askInt("Цена в очках ликвидности", 0, buyer.liquidity);
    price = Math.min(price, buyer.liquidity);
    seller.liquidity += price;
    buyer.liquidity -= price;
    const i = seller.deals.indexOf(deal);
    if (i >= 0) seller.deals.splice(i, 1);
    buyer.deals.push(deal);
    ui.log(`${seller.name} продал «${db.deals[deal.card_id].name}» ${buyer.name} `
      + `за ${price} очков. Риск перешёл покупателю.`, s);
    return true;
  }

  // ====== конец раунда ======

  phaseRoundEnd() {
    const s = this.state, db = this.db, ui = this.ui;
    if (this.onRoundEnd) this.onRoundEnd(s);
    s.round_number += 1;
    if (s.round_number > db.rounds) {
      s.phase = "finished";
      s.scored = false;
      return;
    }
    s.market_lots = [];
    s.turn_team = 0;
    s.deposit_free_used = {};
    if (s.pending_stress.length && s.round_number === 6) {
      const c = choice(s.pending_stress);
      s.active_stress = [c];
      ui.log(`Жребий определил стресс-сценарий раунда 6: «${db.stress_scenarios[c].name}».`, s);
    }
    s.phase = "round_start";
  }

  // ====== финальный подсчёт ======

  async finalCount() {
    const s = this.state, db = this.db, ui = this.ui;
    if (s.scored) return null;
    ui.clear();
    ui.header(s, db, "ФИНАЛ — Подсчёт очков");

    ui.note("--- Досрочное закрытие сделок (без кубика) ---");
    for (const t of s.teams) {
      for (const d of [...t.deals]) {
        const card = db.deals[d.card_id];
        let bonus = 0;
        if (card.pro === "invest") {
          bonus = db.bank_types[t.bank_type].invest_close_bonus ?? 0;
        }
        const paid = card.body + bonus;
        t.liquidity += paid;
        if (!t.bid_hand.includes(d.discount)) t.bid_hand.push(d.discount);
        ui.log(`${t.name}: «${card.name}» закрыта досрочно, тело ${paid} возвращено.`, s);
      }
      t.deals = [];
    }

    ui.note("--- Возврат долгов по Фондированию ---");
    for (const t of s.teams) {
      for (const f of [...t.funding]) {
        const need = db.funding[f.card_id].liquidity;
        if (t.liquidity >= need) {
          t.liquidity -= need;
        } else {
          const short = need - t.liquidity;
          t.liquidity = 0;
          deductCapital(t, short);
          ui.log(`${t.name}: не хватило ${short} на возврат `
            + `«${db.funding[f.card_id].name}» — списано из Капитала 1:1.`, s);
        }
        ui.log(`${t.name}: возвращено тело «${db.funding[f.card_id].name}» = ${need}.`, s);
      }
      t.funding = [];
    }

    const results = [];
    for (const t of s.teams) {
      const points = (t.capital * 2 + Math.floor(t.liquidity / 2)
        + (t.improvements.length + (t.bank_type !== "base" ? 1 : 0)) * 4);
      const eliminated = t.capital <= 0;
      results.push({
        name: t.name,
        capital: t.capital,
        liquidity: t.liquidity,
        bank: db.bank_types[t.bank_type].name,
        improvements: t.improvements.length,
        points,
        eliminated,
      });
    }
    results.sort((a, b) => (a.eliminated === b.eliminated
      ? b.points - a.points
      : (a.eliminated ? 1 : -1)));
    results.forEach((r, i) => { r.place = i + 1; });

    await ui.finalScreen(results, results[0]);

    s.scored = true;
    ui.showStatus(s, db);
    await ui.pause();
    return { results, winner: results[0].name };
  }
}
