/* Банковская игра — единый локальный движок.
 *
 * Движок отвечает за правила и состояние, но не знает о DOM.
 * Все интерактивные экраны проходят через один Board и один тип Action.
 */
"use strict";

const FUNDING_SLOTS = 4;
const RETURNABLE_FUNDING = ["deposits", "mbk", "penalty_credit"];

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function choice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function kindStr(card) {
  if (card.kind === "A") return `доход каждый раунд +${card.income} (всего +${card.income * card.term})`;
  return `весь куш в конце +${card.payoff}`;
}

function dealNet(card) {
  return card.kind === "A" ? card.income * card.term : card.payoff;
}

function proRequirement(card, db) {
  if (!card.pro) return null;
  const names = Object.values(db.bank_types)
    .filter((bank) => (bank.pro || []).includes(card.pro))
    .map((bank) => bank.name);
  return names.length ? names.join(", ") : "недоступна";
}

function deductCapital(team, amount) {
  team.capital = Math.max(0, team.capital - Math.max(0, amount));
}

function dealRisk(team, deal, db) {
  const card = db.deals[deal.card_id];
  if (!team.improvements.includes("ai_scoring")) return card.risk;
  const improvement = db.improvements.ai_scoring;
  return Math.max(improvement.min_risk, card.risk - improvement.risk_reduction);
}

function totalRisk(team, db) {
  return team.deals.reduce((sum, deal) => sum + dealRisk(team, deal, db), 0);
}

function riskLimit(team, db) {
  let limit = team.capital;
  if (team.improvements.includes("compliance")) {
    limit += db.improvements.compliance.risk_overcap;
  }
  return limit;
}

function canAddRisk(team, risk, db) {
  return totalRisk(team, db) + risk <= riskLimit(team, db);
}

function conveyorLimit(team, db) {
  return db.bank_types[team.bank_type].conveyor_limit;
}

function allowedDeal(team, card, db) {
  if (team.deals.some((deal) => deal.card_id === card.id)) return false;
  const bank = db.bank_types[team.bank_type];
  if (card.pro && !(bank.pro || []).includes(card.pro)) return false;
  if ((card.pro === "kredity" || card.pro === "invest") && team.bank_type === "base") return false;
  if (card.pro && (bank.forbidden_deals || []).includes(card.pro)) return false;
  return true;
}

function dealPrice(team, card, db) {
  let price = card.body;
  if (card.pro === "invest") price -= db.bank_types[team.bank_type].invest_body_discount || 0;
  return Math.max(0, price);
}

function monthlyCost(team, db) {
  return db.bank_types[team.bank_type].monthly_cost;
}

class CardDB {
  constructor(data) {
    this.rounds = data.rounds;
    this.starting_capital = data.starting_capital;
    this.starting_liquidity = data.starting_liquidity;
    this.auction_lots_extra = data.auction_lots_extra;
    this.free_deal_copies = data.free_deal_copies;
    this.auction_deal_copies = data.auction_deal_copies;
    this.pro_deal_copies = data.pro_deal_copies ?? data.auction_deal_copies;
    this.discount_cards = [...data.discount_cards];
    this.capital_exchange_rate = data.capital_exchange_rate;
    this.capital_exchange_max_per_round = data.capital_exchange_max_per_round;
    this.funding = Object.fromEntries(data.funding.map((item) => [item.id, item]));
    this.deals = Object.fromEntries(data.deals.map((item) => [item.id, item]));
    this.improvements = Object.fromEntries(data.improvements.map((item) => [item.id, item]));
    this.bank_types = Object.fromEntries(data.bank_types.map((item) => [item.id, item]));
    this.cb_decisions = Object.fromEntries(data.cb_decisions.map((item) => [item.round, item]));
    this.cb_list = data.cb_decisions;
    this.stress_scenarios = Object.fromEntries(data.stress_scenarios.map((item) => [item.id, item]));
  }

  static load() {
    if (typeof CARDS === "undefined") throw new Error("Нет данных карточек.");
    if (typeof START_CONFIG === "undefined") throw new Error("Нет конфигурации партии.");
    return new CardDB({ ...CARDS, ...START_CONFIG });
  }

  freeDeals() {
    return Object.values(this.deals).filter((deal) => !deal.auction);
  }

  cbDecision(round, state) {
    return state?.cb_decisions?.[round] || this.cb_decisions[round];
  }

  mbkRate(round, stress, state) {
    const decision = this.cbDecision(Math.min(round, this.rounds), state);
    if ((stress || []).includes("S3") && round === 6) return this.stress_scenarios.S3.mbk_rate;
    return decision.mbk_rate ?? 2;
  }
}

function dealFromDict(data) {
  return {
    uid: data.uid,
    card_id: data.card_id,
    column: data.column,
    discount: data.discount ?? null,
    discount_used: !!data.discount_used,
  };
}

function fundingFromDict(data) {
  return {
    uid: data.uid,
    card_id: data.card_id,
    rounds_left: data.rounds_left ?? null,
    free_round: data.free_round ?? 0,
  };
}

class Team {
  constructor(data) {
    this.name = data.name;
    this.capital = data.capital;
    this.liquidity = data.liquidity;
    this.bank_type = data.bank_type || "base";
    this.deals = data.deals || [];
    this.funding = data.funding || [];
    this.improvements = data.improvements || [];
    this.bid_hand = data.bid_hand || [];
    this.bid_used = data.bid_used || [];
    this.reserve_used = !!data.reserve_used;
    this.capital_exchanged_this_round = data.capital_exchanged_this_round || 0;
  }

  dealByUid(uid) { return this.deals.find((deal) => deal.uid === uid) || null; }
  fundingByUid(uid) { return this.funding.find((item) => item.uid === uid) || null; }
  hasImprovement(id) { return this.improvements.includes(id); }
  hasPenaltyCredit() { return this.funding.some((item) => item.card_id === "penalty_credit"); }
  hasReserves() { return this.hasImprovement("reserve_fund") && !this.reserve_used; }

  toDict() {
    return {
      name: this.name, capital: this.capital, liquidity: this.liquidity,
      bank_type: this.bank_type, deals: this.deals.map((item) => ({ ...item })),
      funding: this.funding.map((item) => ({ ...item })), improvements: [...this.improvements],
      bid_hand: [...this.bid_hand], bid_used: [...this.bid_used], reserve_used: this.reserve_used,
      capital_exchanged_this_round: this.capital_exchanged_this_round,
    };
  }

  static fromDict(data) {
    return new Team({
      ...data,
      deals: (data.deals || []).map(dealFromDict),
      funding: (data.funding || []).map(fundingFromDict),
      improvements: [...(data.improvements || [])],
      bid_hand: [...(data.bid_hand || [])],
      bid_used: [...(data.bid_used || [])],
    });
  }
}

class GameState {
  constructor(data = {}) {
    this.teams = data.teams || [];
    this.round_number = data.round_number ?? 1;
    this.phase = data.phase || "round_start";
    this.deck = data.deck || [];
    this.discard = data.discard || [];
    this.market_lots = data.market_lots || [];
    this.active_stress = data.active_stress || [];
    this.pending_stress = data.pending_stress || [];
    this.free_pool = data.free_pool || {};
    this.deposit_free_used = data.deposit_free_used || {};
    this.next_uid = data.next_uid ?? 1;
    this.turn_team = data.turn_team ?? 0;
    this.pro_mixed = !!data.pro_mixed;
    this.scored = !!data.scored;
    this.log = data.log || [];
    this.cb_decisions = data.cb_decisions || {};
  }

  allocUid() { return this.next_uid++; }
  get finished() { return this.phase === "finished"; }

  toDict() {
    return {
      teams: this.teams.map((team) => team.toDict()), round_number: this.round_number,
      phase: this.phase, deck: [...this.deck], discard: [...this.discard],
      market_lots: [...this.market_lots], active_stress: [...this.active_stress],
      pending_stress: [...this.pending_stress], free_pool: { ...this.free_pool },
      deposit_free_used: { ...this.deposit_free_used }, next_uid: this.next_uid,
      turn_team: this.turn_team, pro_mixed: this.pro_mixed,
      scored: this.scored, log: [...this.log], cb_decisions: JSON.parse(JSON.stringify(this.cb_decisions)),
    };
  }

  static fromDict(data) {
    let phase = data.phase || "round_start";
    if (phase === "auction_lots" || phase === "auction_free") phase = "auction";
    return new GameState({
      ...data,
      phase,
      teams: (data.teams || []).map(Team.fromDict),
      deck: [...(data.deck || [])], discard: [...(data.discard || [])],
      market_lots: [...(data.market_lots || [])], active_stress: [...(data.active_stress || [])],
      pending_stress: [...(data.pending_stress || [])], free_pool: { ...(data.free_pool || {}) },
      deposit_free_used: { ...(data.deposit_free_used || {}) }, log: [...(data.log || [])],
    });
  }
}

function newGame(db, names) {
  const state = new GameState();
  const used = new Set();
  const teamNames = Array.isArray(names) && names.length ? names : ["Команда 1", "Команда 2"];
  for (let index = 0; index < teamNames.length; index++) {
    let name = String(teamNames[index] || "").trim() || `Команда ${index + 1}`;
    let suffix = 2;
    while (used.has(name)) name = `${name} (${suffix++})`;
    used.add(name);
    state.teams.push(new Team({
      name, capital: db.starting_capital, liquidity: db.starting_liquidity,
      bid_hand: [...db.discount_cards],
    }));
  }
  for (const card of db.freeDeals()) state.free_pool[card.id] = db.free_deal_copies;
  for (const card of Object.values(db.deals)) {
    if (card.auction && !card.pro) {
      for (let i = 0; i < db.auction_deal_copies; i++) state.deck.push(card.id);
    }
  }
  shuffle(state.deck);
  const decisions = [...db.cb_list];
  shuffle(decisions);
  decisions.forEach((decision, index) => { state.cb_decisions[index + 1] = { ...decision, round: index + 1 }; });
  return state;
}

class Board {
  constructor(game) { this.game = game; }
  get ui() { return this.game.ui; }
  get state() { return this.game.state; }
  get db() { return this.game.db; }

  title(step, text) {
    // ШАГ 5 существует только в партии, где после 5-го раунда идёт стресс-тест
    const total = this.state.round_number === 5 ? 5 : 4;
    return `ШАГ ${step}/${total} — ${text}`;
  }

  desk(step, text, showStatus = true) {
    this.ui.clear();
    this.ui.header(this.state, this.db, this.title(step, text));
    if (showStatus) this.ui.showStatus(this.state, this.db);
  }

  turn(team, step, text) {
    this.ui.clear();
    this.ui.header(this.state, this.db, this.title(step, text));
    this.ui.showTable(team, this.state, this.db);
    this.ui.showStatus(this.state, this.db);
  }

  /** Обновить стол команды и общий статус прямо во время действия. */
  refresh(team) {
    this.ui.showTable(team, this.state, this.db);
    this.ui.showStatus(this.state, this.db);
  }

  async pick(prompt, pairs, back = "Назад") {
    const options = pairs.map(([label, value]) => ({ label, value }));
    if (back) options.push({ label: back, value: null });
    if (!options.length) return null;
    const index = await this.ui.askChoice(prompt, options);
    return options[index]?.value ?? null;
  }

  async confirm(title, lines) {
    const accepted = await this.ui.confirm(title, lines);
    if (!accepted) this.ui.note("Отменено.");
    return accepted;
  }

  async pause(text = "Продолжить") { return this.ui.pause(text); }

  async menu(team, prompt, actions) {
    for (;;) {
      const visible = actions.filter((action) => !action.when || action.when(team));
      const options = visible.map((action) => ({
        label: typeof action.label === "function" ? action.label(team) : action.label,
        value: action,
      }));
      const index = await this.ui.askChoice(prompt, options);
      const action = options[index]?.value;
      if (!action) continue;
      const done = await action.run(team);
      if (done) return true;
    }
  }

  finishAction() {
    return {
      label: "Завершить ход",
      run: (team) => this.ui.askYesNo(`Завершить ход ${team.name}?`, true),
    };
  }

  async turnLoop(step, text, actions, prompt) {
    while (this.state.turn_team < this.state.teams.length) {
      const team = this.state.teams[this.state.turn_team];
      this.turn(team, step, text);
      if (await this.menu(team, prompt || "Что делаем?", actions)) {
        this.state.turn_team += 1;
      }
    }
    this.state.turn_team = 0;
  }

  async info(...messages) {
    for (const message of messages) this.ui.note(message);
    await this.pause("Назад");
  }
}

class Game {
  constructor(db, state, ui, save) {
    this.db = db;
    this.state = state;
    this.ui = ui;
    this.save = save;
    this.board = new Board(this);
    this.steps = {
      round_start: () => this.startRound(),
      funding: () => this.fundingStep(),
      auction: () => this.auctionStep(),
      settlement: () => this.settlementStep(),
      stress: () => this.stressStep(),
      round_end: () => this.endRound(),
    };
  }

  async runLoop() {
    while (!this.state.finished) {
      const handler = this.steps[this.state.phase];
      if (!handler) throw new Error(`Неизвестная фаза: ${this.state.phase}`);
      await handler();
    }
  }

  draw() {
    if (!this.state.deck.length && this.state.discard.length) {
      this.state.deck = [...this.state.discard];
      this.state.discard = [];
      shuffle(this.state.deck);
      this.ui.log("Колода пуста — сброс перемешан заново.", this.state);
    }
    return this.state.deck.shift() || null;
  }

  mixPro() {
    if (this.state.pro_mixed) return;
    for (const card of Object.values(this.db.deals)) {
      if (card.auction && card.pro) {
        for (let i = 0; i < this.db.pro_deal_copies; i++) this.state.deck.push(card.id);
      }
    }
    shuffle(this.state.deck);
    this.state.pro_mixed = true;
  }

  async startRound() {
    const s = this.state;
    if (this.save) this.save(s);
    const decision = this.db.cbDecision(s.round_number, s);
    this.board.desk(1, "Открытие раунда · решение ЦБ и рынок");
    this.ui.note(decision.text);
    if (s.round_number === 2) {
      this.mixPro();
      this.ui.log("В колоду добавлены сделки PRO.", s);
    }
    if (s.round_number === 6) await this.applyStress();
    s.market_lots = [];
    for (let i = 0; i < s.teams.length + this.db.auction_lots_extra; i++) {
      const id = this.draw();
      if (id) s.market_lots.push(id);
    }
    this.ui.showMarket(s, this.db);
    this.ui.showStatus(s, this.db);
    this.ui.note("Шаг 1 — финансирование. После завершения ходов начнутся торги на шаге 2.");
    s.phase = "funding";
    s.turn_team = 0;
  }

  async applyStress() {
    const s = this.state;
    for (const id of s.active_stress) {
      const stress = this.db.stress_scenarios[id];
      if (id === "S2") {
        for (const team of s.teams) {
          const count = team.funding.filter((item) => item.card_id === "deposits").length;
          if (!count) continue;
          if (team.hasImprovement(stress.waived_by)) {
            this.ui.log(`${team.name}: вклады защищены мобильным приложением.`, s);
          } else {
            this.pay(team, count * stress.deposit_penalty);
            this.ui.log(`${team.name}: набег вкладчиков — списано ${count * stress.deposit_penalty}.`, s);
          }
        }
      }
      if (id === "S1") {
        for (const team of s.teams) {
          const count = team.deals.filter((deal) => this.db.deals[deal.card_id].sector === "Стройка").length;
          if (count >= stress.concentration_cards) {
            deductCapital(team, stress.concentration_penalty);
            this.ui.log(`${team.name}: концентрация Стройки — −${stress.concentration_penalty} капитала.`, s);
          }
        }
      }
    }
    if (s.active_stress.length) await this.board.pause("Показать последствия");
  }

  async fundingStep() {
    const actions = [
      { label: "Взять долг у ЦБ", run: (team) => this.takeFunding(team) },
      { label: "Купить улучшение или специализацию", run: (team) => this.buyUpgrade(team) },
      { label: "Вернуть долг в ЦБ", when: (team) => team.funding.some((item) => RETURNABLE_FUNDING.includes(item.card_id)), run: (team) => this.returnFunding(team) },
      this.board.finishAction(),
    ];
    await this.board.turnLoop(1, "Долги и покупки в ЦБ", actions);
    this.state.phase = "auction";
  }

  fundingRate(id) {
    const item = this.db.funding[id];
    return item.per_round === "key_rate" ? this.db.mbkRate(this.state.round_number, this.state.active_stress, this.state) : item.per_round;
  }

  async takeFunding(team) {
    const bank = this.db.bank_types[team.bank_type];
    if (team.funding.length >= FUNDING_SLOTS) return this.board.info("Все слоты долгов заняты.");
    const pairs = Object.values(this.db.funding)
      .filter((item) => !item.forced && !(bank.forbidden_funding || []).includes(item.id))
      .map((item) => [`${item.name} · +${item.liquidity} сейчас · платёж ${this.fundingRate(item.id)}/р.`, item.id]);
    const id = await this.board.pick("Что взять у ЦБ?", pairs);
    if (id === null) return;
    const item = this.db.funding[id];
    const details = [`+${item.liquidity} баланса сейчас`, `платёж ${this.fundingRate(id)} каждый раунд`, item.note || ""];
    if (id === "deposits" && this.db.cbDecision(this.state.round_number, this.state).free_first_deposit) details.push("первая карта вкладов в этом раунде обслуживается бесплатно");
    if (!await this.board.confirm(`Взять «${item.name}»?`, details)) return;
    let freeRound = 0;
    if (id === "deposits" && this.db.cbDecision(this.state.round_number, this.state).free_first_deposit && !this.state.deposit_free_used[team.name]) {
      freeRound = this.state.round_number;
      this.state.deposit_free_used[team.name] = true;
    }
    team.funding.push({ uid: this.state.allocUid(), card_id: id, rounds_left: item.term, free_round: freeRound });
    team.liquidity += item.liquidity;
    this.board.refresh(team);
    this.ui.log(`${team.name}: взял «${item.name}» → +${item.liquidity}.`, this.state);
  }

  async buyUpgrade(team) {
    if (team.hasPenaltyCredit()) return this.board.info("Штрафной кредит блокирует покупку улучшений.");
    const pairs = [];
    if (team.bank_type === "base" && this.state.round_number >= this.db.bank_types.commercial.min_round) {
      for (const id of ["commercial", "investment", "ecosystem"]) {
        const bank = this.db.bank_types[id];
        pairs.push([`Специализация «${bank.name}» · ${bank.price}`, ["bank", id]]);
      }
    }
    if (team.improvements.length < 3) {
      for (const [id, item] of Object.entries(this.db.improvements)) {
        if (!team.improvements.includes(id)) pairs.push([`Улучшение «${item.name}» · ${item.price}`, ["upgrade", id]]);
      }
    }
    if (!pairs.length) return this.board.info("Доступных покупок нет.");
    const selected = await this.board.pick("Что купить?", pairs);
    if (!selected) return;
    const [kind, id] = selected;
    const item = kind === "bank" ? this.db.bank_types[id] : this.db.improvements[id];
    if (!await this.board.confirm(`Купить «${item.name}»?`, [`цена: ${item.price} баланса`, item.note || ""])) return;
    if (team.liquidity < item.price) return this.board.info(`Недостаточно баланса: нужно ${item.price}, есть ${team.liquidity}.`);
    team.liquidity -= item.price;
    if (kind === "bank") team.bank_type = id;
    else team.improvements.push(id);
    this.board.refresh(team);
    this.ui.log(`${team.name}: куплено «${item.name}» (−${item.price}).`, this.state);
  }

  async returnFunding(team) {
    const pairs = team.funding.filter((item) => RETURNABLE_FUNDING.includes(item.card_id)).map((item) => [
      `Вернуть «${this.db.funding[item.card_id].name}» · −${this.db.funding[item.card_id].liquidity}`,
      item.uid,
    ]);
    const uid = await this.board.pick("Какой долг вернуть?", pairs);
    if (uid === null) return;
    const instance = team.fundingByUid(uid);
    const item = this.db.funding[instance.card_id];
    if (!await this.board.confirm(`Вернуть «${item.name}»?`, [`отдать ${item.liquidity} баланса`, "платёж по карте прекращается"])) return;
    if (team.liquidity < item.liquidity) return this.board.info("Недостаточно баланса для возврата.");
    team.liquidity -= item.liquidity;
    team.funding = team.funding.filter((entry) => entry.uid !== uid);
    this.board.refresh(team);
    this.ui.log(`${team.name}: вернул «${item.name}».`, this.state);
  }

  lotContext(card, extra = "", bids = null) {
    this.ui.clear();
    this.ui.header(this.state, this.db, this.board.title(2, "Торги · карточка сделки"));
    this.ui.showAuctionCard(card, this.db, extra, bids);
    this.ui.showStatus(this.state, this.db);
  }

  bidReason(team, card) {
    if (team.deals.some((deal) => deal.card_id === card.id)) return "такая сделка уже есть";
    if (!allowedDeal(team, card, this.db)) return "недоступно для типа банка";
    if (team.deals.length >= conveyorLimit(team, this.db)) return "конвейер сделок заполнен";
    const price = dealPrice(team, card, this.db);
    if (team.liquidity < price) return `не хватает баланса (нужно ${price})`;
    if (!canAddRisk(team, card.risk, this.db)) return `риск превышает норматив (предел ${riskLimit(team, this.db)})`;
    if (!team.bid_hand.length) return "нет карточек скидки";
    return null;
  }

  async auctionStep() {
    while (this.state.market_lots.length) {
      await this.auctionLot(this.state.market_lots.shift());
    }
    const actions = [
      { label: "Взять сделку у ЦБ без торгов", run: (team) => this.takeFreeDeal(team) },
      this.board.finishAction(),
    ];
    await this.board.turnLoop(3, "Сделки у ЦБ без торгов", actions, "Что взять после торгов?");
    this.state.phase = "settlement";
  }

  async auctionLot(id) {
    const card = this.db.deals[id];
    const bids = [];
    for (const team of this.state.teams) {
      const reason = this.bidReason(team, card);
      this.lotContext(card, reason ? `${team.name}: ${reason}` : `${team.name}: решение команды`);
      this.ui.showTable(team, this.state, this.db);
      if (reason || !(await this.ui.askYesNo(`${team.name}: участвовать в торгах?`, false))) {
        bids.push({ team, bid: null, reason });
        continue;
      }
      const pairs = [...team.bid_hand].sort((a, b) => a - b).map((value) => [`Скидка ${value} · доход +${dealNet(card) + value}`, value]);
      const bid = await this.board.pick("Какую карточку скидки поставить?", pairs);
      if (bid === null) bids.push({ team, bid: null, reason: "пас" });
      else {
        team.bid_hand.splice(team.bid_hand.indexOf(bid), 1);
        team.bid_used.push(bid);
        bids.push({ team, bid, reason: null });
      }
    }
    this.lotContext(card, "Вскрытие ставок", bids);
    const groups = new Map();
    for (const item of bids) {
      const key = item.bid === null ? `пас${item.reason ? ` — ${item.reason}` : ""}` : `ставка ${item.bid}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item.team.name);
    }
    for (const [key, names] of groups) this.ui.note(`${names.join(", ")}: ${key}`);
    const contenders = bids.filter((item) => item.bid !== null);
    if (!contenders.length) {
      this.state.discard.push(id);
      this.ui.log(`За «${card.name}» никто не боролся.`, this.state);
      return this.board.pause();
    }
    contenders.sort((a, b) => b.bid - a.bid || totalRisk(a.team, this.db) - totalRisk(b.team, this.db));
    let finalists = contenders.filter((item) => item.bid === contenders[0].bid);
    const minRisk = Math.min(...finalists.map((item) => totalRisk(item.team, this.db)));
    finalists = finalists.filter((item) => totalRisk(item.team, this.db) === minRisk);
    let winner = finalists[0];
    if (finalists.length > 1) winner = finalists[(await this.ui.throwDice()) % finalists.length];
    this.takeDeal(winner.team, id, winner.bid);
    this.ui.note(`Победитель: ${winner.team.name}, скидка ${winner.bid}.`);
    await this.board.pause();
  }

  takeDeal(team, id, bid) {
    const card = this.db.deals[id];
    const price = dealPrice(team, card, this.db);
    team.liquidity -= price;
    team.deals.push({ uid: this.state.allocUid(), card_id: id, column: Math.min(3, Math.max(1, card.term)), discount: bid, discount_used: false });
    this.board.refresh(team);
    this.ui.log(`${team.name}: взял «${card.name}», уплачено ${price}.`, this.state);
  }

  freeReason(team, card) {
    if (team.deals.some((deal) => deal.card_id === card.id)) return "такая сделка уже есть";
    if (!allowedDeal(team, card, this.db)) return "недоступно для типа банка";
    if (team.deals.length >= conveyorLimit(team, this.db)) return "конвейер заполнен";
    if (team.liquidity < dealPrice(team, card, this.db)) return "не хватает баланса";
    if (!canAddRisk(team, card.risk, this.db)) return "не хватает норматива риска";
    return null;
  }

  async takeFreeDeal(team) {
    const pairs = [];
    for (const [id, count] of Object.entries(this.state.free_pool)) {
      if (count <= 0) continue;
      const card = this.db.deals[id];
      if (!this.freeReason(team, card)) pairs.push([`${card.name} · ${dealPrice(team, card, this.db)} баланса`, id]);
    }
    if (!pairs.length) return this.board.info("Доступных сделок у ЦБ нет.");
    const id = await this.board.pick("Какую сделку взять?", pairs);
    if (id === null) return;
    const card = this.db.deals[id];
    const price = dealPrice(team, card, this.db);
    if (!await this.board.confirm(`Взять «${card.name}»?`, [`заплатить ${price} баланса`, kindStr(card), `риск ${card.risk}`])) return;
    this.state.free_pool[id] -= 1;
    team.liquidity -= price;
    team.deals.push({ uid: this.state.allocUid(), card_id: id, column: Math.min(3, Math.max(1, card.term)), discount: null, discount_used: true });
    this.board.refresh(team);
    this.ui.log(`${team.name}: взял у ЦБ «${card.name}».`, this.state);
  }

  async settlementStep() {
    this.board.desk(4, "Расчёты · платежи и доходы");
    this.payFixedCosts();
    this.payFunding();
    this.payDealIncome();
    this.applyBonuses();
    await this.closeExpiredDeals();
    this.shiftDeals();
    await this.resolveFundingTerms();
    await this.exchangeCapital();
    this.applyRevision();
    this.board.desk(4, `Расчёты · раунд ${this.state.round_number} завершены`, false);
    this.ui.note(`Раунд ${this.state.round_number} завершён.`);
    await this.board.pause("Завершить расчёты");
    this.state.phase = this.state.round_number === 5 ? "stress" : "round_end";
  }

  payFixedCosts() {
    for (const team of this.state.teams) {
      const amount = monthlyCost(team, this.db);
      this.pay(team, amount);
      this.ui.log(`${team.name}: расход банка −${amount}.`, this.state);
    }
  }

  payFunding() {
    for (const team of this.state.teams) {
      for (const funding of [...team.funding]) {
        const item = this.db.funding[funding.card_id];
        let amount = funding.card_id === "mbk" ? this.db.mbkRate(this.state.round_number, this.state.active_stress, this.state) : item.per_round;
        if (funding.card_id === "deposits") amount = this.db.bank_types[team.bank_type].deposit_cost ?? item.per_round;
        if (funding.free_round === this.state.round_number) amount = 0;
        if (amount) this.pay(team, amount);
        this.ui.log(`${team.name}: платёж по «${item.name}» −${amount}.`, this.state);
      }
    }
  }

  payDealIncome() {
    const decision = this.db.cbDecision(this.state.round_number, this.state);
    for (const team of this.state.teams) {
      for (const deal of team.deals) {
        const card = this.db.deals[deal.card_id];
        if (card.kind !== "A") continue;
        let income = card.id === "free_ofz" && decision.ofz_bonus !== undefined ? decision.ofz_bonus : card.income;
        if ((decision.subsidy_sectors || []).includes(card.sector)) income += decision.subsidy_amount;
        if (!deal.discount_used) { income += deal.discount || 0; deal.discount_used = true; }
        team.liquidity += Math.max(0, income);
        this.ui.log(`${team.name}: доход по «${card.name}» +${Math.max(0, income)}.`, this.state);
      }
    }
  }

  applyBonuses() {
    for (const team of this.state.teams) {
      const bank = this.db.bank_types[team.bank_type];
      if (bank.per_deal_income) team.liquidity += bank.per_deal_income * team.deals.length;
      if (team.hasImprovement("mobile_app")) team.liquidity += 1;
    }
  }

  async closeExpiredDeals() {
    for (const team of this.state.teams) {
      for (const deal of [...team.deals]) {
        if (deal.column === 1) await this.closeDeal(team, deal);
      }
    }
  }

  async closeDeal(team, deal) {
    const card = this.db.deals[deal.card_id];
    const fail = new Set(card.default_on || []);
    if (this.state.active_stress.includes("S1") && card.sector === "Стройка") {
      fail.clear();
      for (let i = 1; i <= this.db.stress_scenarios.S1.construction_fail; i++) fail.add(i);
    }
    this.board.desk(4, `Проверка сделки · ${card.name}`);
    this.ui.showTable(team, this.state, this.db);
    this.ui.note(`Дефолт на бросках: ${[...fail].join(", ") || "нет"}. Штраф −${card.default_penalty} капитала.`);
    const roll = await this.ui.throwDice();
    const failed = fail.has(roll);
    if (failed && team.hasReserves()) {
      if (await this.ui.askYesNo(`${team.name}: использовать Резервный фонд?`, true)) {
        team.improvements = team.improvements.filter((id) => id !== "reserve_fund");
        team.reserve_used = true;
        this.ui.log(`${team.name}: Резервный фонд спас от дефолта.`, this.state);
        return this.finishDeal(team, deal, true);
      }
    }
    if (failed) deductCapital(team, card.default_penalty);
    await this.finishDeal(team, deal, !failed);
  }

  finishDeal(team, deal, success) {
    const card = this.db.deals[deal.card_id];
    let returned = card.body;
    if (card.pro === "invest") returned += this.db.bank_types[team.bank_type].invest_close_bonus || 0;
    let income = 0;
    if (success && card.kind === "B") {
      income = card.payoff + (deal.discount_used ? 0 : deal.discount || 0);
      if (card.pro === "invest" && this.state.round_number === 6 && this.state.active_stress.includes("S3")) income = Math.max(0, income - this.db.stress_scenarios.S3.invest_income_penalty);
    }
    team.liquidity += returned + income;
    team.deals = team.deals.filter((item) => item.uid !== deal.uid);
    this.state.discard.push(card.id);
    this.ui.log(`${team.name}: «${card.name}» закрыта, возвращено ${returned}${income ? ` + доход ${income}` : ""}.`, this.state);
  }

  shiftDeals() {
    for (const team of this.state.teams) {
      for (const deal of team.deals) if (deal.column > 1) deal.column -= 1;
    }
  }

  async resolveFundingTerms() {
    for (const team of this.state.teams) {
      for (const funding of [...team.funding]) {
        if (funding.card_id === "mbk") await this.resolveMbk(team, funding);
        if (funding.card_id === "bonds" && funding.rounds_left != null) {
          funding.rounds_left -= 1;
          if (funding.rounds_left <= 0) this.repayFunding(team, funding);
        }
      }
    }
  }

  async resolveMbk(team, funding) {
    const rate = this.db.mbkRate(this.state.round_number, this.state.active_stress, this.state);
    this.board.turn(team, 4, `МБК · ${team.name}`);
    const action = await this.board.pick("Что сделать с МБК?", [[`Продлить за ${rate}`, "extend"], ["Вернуть 10 баланса", "return"]], null);
    if (action === "extend") this.pay(team, rate);
    if (action === "return") this.repayFunding(team, funding);
  }

  repayFunding(team, funding) {
    const item = this.db.funding[funding.card_id];
    this.pay(team, item.liquidity);
    team.funding = team.funding.filter((entry) => entry.uid !== funding.uid);
    this.ui.log(`${team.name}: погашен долг «${item.name}».`, this.state);
  }

  async exchangeCapital() {
    const actions = [{
      label: (team) => `Обменять баланс на капитал (${this.db.capital_exchange_rate} → 1)`,
      when: (team) => this.exchangeAvailable(team) > 0,
      run: (team) => this.exchange(team),
    }, this.board.finishAction()];
    await this.board.turnLoop(4, "Обмен прибыли на капитал", actions, "Что сделать с прибылью?");
  }

  exchangeAvailable(team) {
    const possible = Math.floor(team.liquidity / this.db.capital_exchange_rate);
    const limit = this.db.capital_exchange_max_per_round;
    return limit == null ? possible : Math.min(possible, Math.max(0, limit - team.capital_exchanged_this_round));
  }

  async exchange(team) {
    const available = this.exchangeAvailable(team);
    const pairs = await this.ui.askInt(`Сколько пар обменять? (доступно ${available})`, 1, available);
    const cost = pairs * this.db.capital_exchange_rate;
    if (!await this.board.confirm(`Обменять ${cost} баланса?`, [`получить ${pairs} капитала`, `останется баланса: ${team.liquidity - cost}`])) return false;
    team.liquidity -= cost;
    team.capital += pairs;
    team.capital_exchanged_this_round += pairs;
    this.board.refresh(team);
    this.ui.log(`${team.name}: обменял ${cost} баланса на ${pairs} капитала.`, this.state);
    this.ui.note(`Обмен ${cost} → +${pairs} капитала. Теперь капитал: ${team.capital}, баланс: ${team.liquidity}.`);
    return false;
  }

  applyRevision() {
    const decision = this.db.cbDecision(this.state.round_number, this.state);
    if (decision.revision_min_gap == null) return;
    for (const team of this.state.teams) {
      if (team.capital - totalRisk(team, this.db) < decision.revision_min_gap) {
        this.pay(team, decision.revision_penalty);
        this.ui.log(`${team.name}: предписание ЦБ −${decision.revision_penalty}.`, this.state);
      }
    }
  }

  async stressStep() {
    const s = this.state;
    this.board.desk(5, "Стресс-тест и межбанковская торговля");
    if (!s.pending_stress.length) {
      s.pending_stress = Object.keys(this.db.stress_scenarios).sort(() => Math.random() - 0.5).slice(0, 2).sort();
      this.ui.note("Вскрыты два стресс-сценария:");
      for (const id of s.pending_stress) this.ui.note(`«${this.db.stress_scenarios[id].name}» — ${this.db.stress_scenarios[id].text}`);
      while (await this.ui.askYesNo("Провести межбанковскую сделку?", false)) {
        if (!await this.interbank()) break;
      }
    }
    await this.board.pause("Завершить шаг 4");
    s.phase = "round_end";
  }

  async interbank() {
    const teams = this.state.teams;
    const sellers = teams.filter((team) => team.deals.length);
    if (!sellers.length) { await this.board.info("Нет сделок для продажи."); return false; }
    const sellerName = teams.length === 2 ? sellers[0].name : await this.board.pick("Кто продаёт?", sellers.map((team) => [`${team.name} · сделок ${team.deals.length}`, team.name]), null);
    if (!sellerName) return false;
    const seller = teams.find((team) => team.name === sellerName);
    const buyerName = teams.length === 2 ? teams.find((team) => team !== seller).name : await this.board.pick("Кто покупает?", teams.filter((team) => team !== seller).map((team) => [`${team.name} · баланс ${team.liquidity}`, team.name]), null);
    if (!buyerName) return false;
    const buyer = teams.find((team) => team.name === buyerName);
    this.board.desk(5, "Межбанковская сделка");
    this.ui.note(`Продавец: ${seller.name}. Покупатель: ${buyer.name}.`);
    const uid = await this.board.pick("Какую сделку продать?", seller.deals.map((deal) => [this.db.deals[deal.card_id].name, deal.uid]));
    if (uid === null) return false;
    const deal = seller.dealByUid(uid);
    const price = await this.ui.askInt("Цена в балансе", 0, buyer.liquidity);
    seller.liquidity += price;
    buyer.liquidity -= price;
    seller.deals = seller.deals.filter((item) => item.uid !== uid);
    buyer.deals.push(deal);
    this.ui.log(`${seller.name} продал «${this.db.deals[deal.card_id].name}» ${buyer.name} за ${price}.`, this.state);
    this.board.refresh(buyer);
    return true;
  }

  endRound() {
    if (this.save) this.save(this.state);
    for (const team of this.state.teams) {
      team.capital_exchanged_this_round = 0;
      team.bid_hand.push(...team.bid_used);
      team.bid_used = [];
    }
    this.state.round_number += 1;
    if (this.state.round_number > this.db.rounds) {
      this.state.phase = "finished";
      this.state.scored = false;
      return;
    }
    if (this.state.pending_stress.length && this.state.round_number === 6) {
      this.state.active_stress = [choice(this.state.pending_stress)];
      this.ui.log(`В раунде 6 активен сценарий «${this.db.stress_scenarios[this.state.active_stress[0]].name}».`, this.state);
    }
    this.state.market_lots = [];
    this.state.turn_team = 0;
    this.state.deposit_free_used = {};
    this.state.phase = "round_start";
  }

  pay(team, amount) {
    if (amount <= 0) return;
    if (team.liquidity >= amount) { team.liquidity -= amount; return; }
    let rest = amount - team.liquidity;
    team.liquidity = 0;
    while (rest > 0 && team.funding.filter((item) => item.card_id === "penalty_credit").length < 3 && team.funding.length < FUNDING_SLOTS) {
      team.funding.push({ uid: this.state.allocUid(), card_id: "penalty_credit", rounds_left: null, free_round: 0 });
      team.liquidity += this.db.funding.penalty_credit.liquidity;
      rest -= this.db.funding.penalty_credit.liquidity;
    }
    if (rest > 0) deductCapital(team, rest);
  }

  async finalCount() {
    if (this.state.scored) return null;
    this.ui.clear();
    this.ui.header(this.state, this.db, "Финал · подсчёт очков");
    this.ui.showStatus(this.state, this.db);
    for (const team of this.state.teams) {
      for (const deal of [...team.deals]) {
        const card = this.db.deals[deal.card_id];
        team.liquidity += card.body + (card.pro === "invest" ? this.db.bank_types[team.bank_type].invest_close_bonus || 0 : 0);
      }
      team.deals = [];
      for (const funding of [...team.funding]) this.repayFunding(team, funding);
    }
    const results = this.state.teams.map((team) => ({
      name: team.name, capital: team.capital, liquidity: team.liquidity,
      bank: this.db.bank_types[team.bank_type].name, improvements: team.improvements.length,
      points: team.capital * 2 + Math.floor(team.liquidity / 2) + (team.improvements.length + (team.bank_type !== "base" ? 1 : 0)) * 4,
      eliminated: team.capital <= 0,
    }));
    results.sort((a, b) => (a.eliminated === b.eliminated ? b.points - a.points : a.eliminated ? 1 : -1));
    results.forEach((result, index) => { result.place = index + 1; });
    await this.ui.finalScreen(results, results[0]);
    this.state.scored = true;
    await this.board.pause();
    return { results, winner: results[0].name };
  }
}
