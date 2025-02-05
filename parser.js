const PARSER_VERSION = 7;
const log = require('./pino.js');
const fs = require('fs');
const path = require('path');
const ReplayTypes = require(path.join(__dirname, 'constants.js'));
const heroprotocol = require('heroprotocol');
const XRegExp = require('xregexp');
const attrs = require('./attr.js');

// uncomment for debug
// log.level = 'trace';

// 2.55.2.87306
const MAX_SUPPORTED_BUILD = 87774;

const BSTEP_FRAME_THRESHOLD = 8;

const ReplayDataType = {
  game: 'gameevents',
  message: 'messageevents',
  tracker: 'trackerevents',
  attribute: 'attributeevents',
  header: 'header',
  details: 'details',
  init: 'initdata',
  stats: 'stats',
  lobby: 'battlelobby',
};

// lil bit of duplication here but for fallback reasons, this exists
const ReplayToProtocolType = {
  gameevents: heroprotocol.GAME_EVENTS,
  messageevents: heroprotocol.MESSAGE_EVENTS,
  trackerevents: heroprotocol.TRACKER_EVENTS,
  attributeevents: heroprotocol.ATTRIBUTES_EVENTS,
  header: heroprotocol.HEADER,
  details: heroprotocol.DETAILS,
  initdata: heroprotocol.INITDATA,
  battlelobby: 'replay.server.battlelobby',
};

const ReplayStatus = {
  OK: 1,
  Unsupported: 0,
  Duplicate: -1,
  Failure: -2,
  UnsupportedMap: -3,
  ComputerPlayerFound: -4,
  Incomplete: -5,
  TooOld: -6,
  Unverified: -7,
};

const StatusString = {
  1: 'OK',
  0: 'Unsupported',
  '-1': 'Duplicate',
  '-2': 'Internal Exception',
  '-3': 'Unsupported Map',
  '-4': 'Computer Player Found',
  '-5': 'Incomplete',
  '-6': 'Too Old',
  '-7': 'Unverified',
};

// it's everything except gameevents which is just a massive amount of data
const CommonReplayData = [
  ReplayDataType.message,
  ReplayDataType.tracker,
  ReplayDataType.attribute,
  ReplayDataType.header,
  ReplayDataType.details,
  ReplayDataType.init,
  ReplayDataType.lobby,
];
const AllReplayData = [
  ReplayDataType.game,
  ReplayDataType.message,
  ReplayDataType.tracker,
  ReplayDataType.attribute,
  ReplayDataType.header,
  ReplayDataType.details,
  ReplayDataType.init,
  ReplayDataType.lobby,
];

function parse(file, requestedData, opts) {
  var replay = {};

  // execute sync
  for (var i in requestedData) {
    log.debug('Retrieving ' + requestedData[i]);
    replay[requestedData[i]] = heroprotocol.get(
      ReplayToProtocolType[requestedData[i]],
      file
    );
  }

  if (opts) {
    if ('saveToFile' in opts) {
      fs.writeFile(opts.saveToFile, JSON.stringify(replay, null, 2), function (
        err
      ) {
        if (err) throw err;
        log.info('Wrote replay data to ' + opts.saveToFile);
      });
    }
  }

  // battletags
  replay.tags = {};
  if (replay[ReplayDataType.lobby]) {
    replay.tags = getBattletags(replay[ReplayDataType.lobby], replay.details.m_playerList);
  }

  return replay;
}

// returns a summary of header data (player ID, date, type, map)
// for checking duplicates
// header does not do anything that's unsupported by the max build number, so it's fine to run all the time.
function getHeader(file) {
  try {
    let data = parse(file, [
      ReplayDataType.header,
      ReplayDataType.details,
      ReplayDataType.init,
      ReplayDataType.tracker,
      ReplayDataType.lobby,
    ]);

    var details = data.details;
    var match = {};

    // header data
    match.version = data.header.m_version;
    match.type = data.header.m_type;

    // game mode
    match.mode =
      data.initdata.m_syncLobbyState.m_gameDescription.m_gameOptions.m_ammId;

    if (match.mode === null) match.mode = -1;

    // map details
    // for localization reasons we need the internal map name from the EndOfGameTalentChoices event
    var tracker = data.trackerevents;
    for (let i in tracker) {
      let event = tracker[i];

      // case on event type
      if (event._eventid === ReplayTypes.TrackerEvent.Stat) {
        if (
          event.m_eventName === ReplayTypes.StatEventType.EndOfGameTalentChoices
        ) {
          let internalMap = event.m_stringData[2].m_value;
          if (internalMap in ReplayTypes.MapType) {
            match.map = ReplayTypes.MapType[event.m_stringData[2].m_value];
            break;
          } else {
            log.error('Unrecognized internal map name: ' + internalMap);
            return { err: 'map' };
          }
        }
      }
    }

    match.date = winFileTimeToDate(details.m_timeUTC);
    match.rawDate = details.m_timeUTC;

    // players
    match.playerIDs = [];
    var playerDetails = details.m_playerList;

    for (var i = 0; i < playerDetails.length; i++) {
      var pdata = playerDetails[i];
      let ToonHandle =
        pdata.m_toon.m_region +
        '-' +
        pdata.m_toon.m_programId +
        '-' +
        pdata.m_toon.m_realm +
        '-' +
        pdata.m_toon.m_id;
      match.playerIDs.push(ToonHandle);
    }

    match.tags = data.tags;

    return match;
  } catch (err) {
    log.error({ error: err });
    return { err: err };
  }
}

function getBattletags(buffer, playerList) {
  if (buffer) {
    let btagRegExp = XRegExp('(\\p{L}|\\d){3,24}#\\d{4,10}[zØ]?', 'g');
    let matches = buffer.toString().match(btagRegExp);

    // process
    let tagMap = [];
    let i = 0;
    for (let match of matches) {
      // split into name + tag
      const name = match.substr(0, match.indexOf('#'));
      const tag = match.substr(match.indexOf('#') + 1);

      if (playerList[i] && playerList[i].m_name === name) {
        const ToonHandle =
          playerList[i].m_toon.m_region +
          '-' +
          playerList[i].m_toon.m_programId +
          '-' +
          playerList[i].m_toon.m_realm +
          '-' +
          playerList[i].m_toon.m_id;
        tagMap.push({ tag, name, full: match, ToonHandle });
        log.trace('Found BattleTag: ' + match);
        i++;
      }
    }

    return tagMap;
  }
}

// processes a replay file and adds it to the database
// the parser no longer requires a heroes talents instance to function.
function processReplay(file, opts = {}) {
  // options
  if (!('getBMData' in opts)) opts.getBMData = true;

  if (!('useAttributeName' in opts)) opts.useAttributeName = false;

  if (!('legacyTalentKeys' in opts)) opts.legacyTalentKeys = false;

  try {
    log.info('Parsing ' + file);

    // parse it
    var data;

    if (opts.getBMData) {
      data = parse(file, AllReplayData);
    } else {
      data = parse(file, CommonReplayData);
    }

    var details = data.details;

    // start with the match, since a lot of things are keyed off of it
    // the match id is not generated until insertion (key off unique id generated by database)
    // TODO: de-duplication
    var match = {};

    // header data
    match.version = data.header.m_version;

    // version check
    if (
      match.version.m_build > MAX_SUPPORTED_BUILD &&
      !opts.overrideVerifiedBuild
    ) {
      log.warn(
        `Unverified build number ${match.version.m_build}, aborting. Override this behavior with the 'overrideVerifiedBuild' option.`
      );
      return { status: ReplayStatus.Unverified };
    } else if (
      match.version.m_build > MAX_SUPPORTED_BUILD &&
      opts.overrideVerifiedBuild === true
    ) {
      log.warn(
        `Proceeding with processing unverified build number ${match.version.m_build}. Some values may be missing and unexpected behavior may occur.`
      );
    }

    match.type = data.header.m_type;
    match.loopLength = data.header.m_elapsedGameLoops;
    match.filename = file;

    // game mode
    match.mode =
      data.initdata.m_syncLobbyState.m_gameDescription.m_gameOptions.m_ammId;

    if (match.mode === null) match.mode = -1;

    // check for supported mode
    if (match.mode === ReplayTypes.GameMode.Brawl) {
      log.warn('Brawls are not supported!');
      return { status: ReplayStatus.Unsupported };
    }

    // map details
    // for localization reasons we need the internal map name from the EndOfGameTalentChoices event
    var tracker = data.trackerevents;
    for (let i in tracker) {
      let event = tracker[i];

      // case on event type
      if (event._eventid === ReplayTypes.TrackerEvent.Stat) {
        if (
          event.m_eventName === ReplayTypes.StatEventType.EndOfGameTalentChoices
        ) {
          let internalMap = event.m_stringData[2].m_value;
          if (internalMap in ReplayTypes.MapType) {
            match.map = ReplayTypes.MapType[event.m_stringData[2].m_value];
            break;
          } else {
            log.warn('Unrecognized internal map name: ' + internalMap);
            return { status: ReplayStats.UnsupportedMap };
          }
        }
      }
    }
    // match.map = details.m_title;

    match.date = winFileTimeToDate(details.m_timeUTC);
    log.debug(
      'Processing ' +
        ReplayTypes.GameModeStrings[match.mode] +
        ' game on ' +
        match.map +
        ' at ' +
        match.date
    );

    match.rawDate = details.m_timeUTC;

    // check for duplicate matches somewhere else, this function executes without async calls
    // until insertion. Should have a processReplays function that does the de-duplication.
    //this._db.matches.find({ 'map' : match.map, 'date' : match.date, 'loopLength' : match.loopLength }, function(err, docs) {

    // players
    // the match will just store the players involed. The details will be stored
    // in a document in the heroData db
    // players are 1-indexed, look at details first
    var players = {};

    match.playerIDs = [];
    match.heroes = [];
    match.levelTimes = { 0: {}, 1: {} };
    var playerDetails = details.m_playerList;

    log.debug('Gathering Preliminary Player Data...');
    for (var i = 0; i < playerDetails.length; i++) {
      var pdata = playerDetails[i];
      var pdoc = {};

      // collect data
      pdoc.hero = pdata.m_hero;
      // some uh, unicode issues here
      // we're gonna use the NA hero name and remove his ú
      if (pdoc.hero === 'Lúcio') pdoc.hero = 'Lucio';

      pdoc.name = pdata.m_name;
      pdoc.uuid = pdata.m_toon.m_id;
      pdoc.region = pdata.m_toon.m_region;
      pdoc.realm = pdata.m_toon.m_realm;

      pdoc.ToonHandle =
        pdata.m_toon.m_region +
        '-' +
        pdata.m_toon.m_programId +
        '-' +
        pdata.m_toon.m_realm +
        '-' +
        pdata.m_toon.m_id;

      // ok so actually search forward here and look for a name match
      for (let j = i; j < data.tags.length; j++) {
        if (pdoc.ToonHandle === data.tags[j].ToonHandle) {
          pdoc.tag = parseInt(data.tags[j].tag);
          break;
        }
      }

      // match region should be logged too, since all players should be
      // in the same region, overwrite constantly
      match.region = pdata.m_toon.m_region;

      pdoc.team = pdata.m_teamId; /// the team id doesn't neatly match up with the tracker events, may adjust later

      // DEBUG
      //if (pdata.m_toon.m_realm === 0) {
      //  pdoc.ToonHandle = pdata.m_name + ' [CPU]';
      //}

      pdoc.gameStats = {};
      pdoc.talents = {};
      pdoc.takedowns = [];
      pdoc.deaths = [];
      pdoc.gameStats.awards = [];
      pdoc.bsteps = [];
      pdoc.voiceLines = [];
      pdoc.sprays = [];
      pdoc.taunts = [];
      pdoc.dances = [];
      pdoc.units = {};
      pdoc.votes = 0;
      pdoc.rawDate = match.rawDate;
      pdoc.map = match.map;
      pdoc.date = match.date;
      pdoc.build = match.version.m_build;
      pdoc.mode = match.mode;
      pdoc.version = match.version;
      pdoc.globes = { count: 0, events: [] };

      players[pdoc.ToonHandle] = pdoc;
      match.playerIDs.push(pdoc.ToonHandle);

      log.trace('Found player ' + pdoc.ToonHandle + ' (' + pdoc.name + ')');
    }

    log.debug('Preliminary Player Processing Complete');
    log.debug('Matching Tracker Player ID to handles...');

    // construct identfier map for player handle to internal player object id
    // maps player id in the Tracker data to the proper player object
    var playerIDMap = {};
    match.loopGameStart = 0; // fairly sure this is always 610 but just in case look for the "GatesOpen" event

    // the match length is actually incorrect. need to track core death events for actual match time.
    var cores = {};

    for (let i = 0; i < tracker.length; i++) {
      let event = tracker[i];

      // case on event type
      if (event._eventid === ReplayTypes.TrackerEvent.Stat) {
        if (event.m_eventName === ReplayTypes.StatEventType.PlayerInit) {
          if (event.m_stringData[0].m_value === 'Computer') {
            log.warn('Games with computer players are not supported');
            // DEBUG
            //event.m_stringData.push({ m_value: `Player ${event.m_intData[0].m_value} [CPU]`});
            return { status: ReplayStatus.ComputerPlayerFound };
          }

          playerIDMap[event.m_intData[0].m_value] =
            event.m_stringData[1].m_value;

          const attrName =
            data.attributeevents.scopes[event.m_intData[0].m_value]['4002'][0]
              .value;
          players[event.m_stringData[1].m_value].heroLevel = parseInt(
            data.attributeevents.scopes[event.m_intData[0].m_value]['4008'][0]
              .value
          );
          players[event.m_stringData[1].m_value].hero = opts.useAttributeName
            ? attrName
            : attrs.heroAttribute[attrName];

          // right hero names should be tracked here...
          match.heroes.push(players[event.m_stringData[1].m_value].hero);

          log.trace(
            'Player ' +
              event.m_stringData[1].m_value +
              ' has tracker ID ' +
              event.m_intData[0].m_value
          );
        } else if (event.m_eventName === ReplayTypes.StatEventType.GatesOpen) {
          match.loopGameStart = event._gameloop;
        }
      } else if (event._eventid === ReplayTypes.TrackerEvent.UnitBorn) {
        if (
          event.m_unitTypeName === ReplayTypes.UnitType.KingsCore ||
          event.m_unitTypeName === ReplayTypes.UnitType.VanndarStormpike ||
          event.m_unitTypeName === ReplayTypes.UnitType.DrekThar
        ) {
          let tag = event.m_unitTagIndex + '-' + event.m_unitTagRecycle;
          cores[tag] = event;

          log.trace(
            'Team ' + (event.m_upkeepPlayerId - 11) + ' core ' + tag + ' found'
          );
        }
      }
    }

    match.length = loopsToSeconds(match.loopLength - match.loopGameStart);

    log.debug('Player ID Mapping Complete');

    log.debug('Gathering player cosmetic info...');

    let lobbyState = data.initdata.m_syncLobbyState.m_lobbyState.m_slots;
    var playerLobbyID = {};
    for (let i = 0; i < lobbyState.length; i++) {
      let p = lobbyState[i];
      let id = p.m_toonHandle;

      if (id === '') continue;

      if (!(id in players)) continue;

      players[id].skin = p.m_skin;
      players[id].announcer = p.m_announcerPack;
      players[id].mount = p.m_mount;
      players[id].silenced = p.m_hasSilencePenalty;

      if ('m_hasVoiceSilencePenalty' in p)
        players[id].voiceSilenced = p.m_hasVoiceSilencePenalty;

      playerLobbyID[p.m_userId] = id;
      players[id].length = match.length;
    }

    let playerList = data.details.m_playerList;
    var playerWorkingSlotID = {};
    for (let i = 0; i < playerList.length; i++) {
      let pl = playerList[i];
      let toon =
        pl.m_toon.m_region +
        '-Hero-' +
        pl.m_toon.m_realm +
        '-' +
        pl.m_toon.m_id;
      playerWorkingSlotID[pl.m_workingSetSlotId] = toon;
    }

    // fallback plan
    // the initdata.m_lobbyState.m_slots should have it instead
    if (null in playerWorkingSlotID) {
      log.warn('playerWorkingSlotIDs are null. Proceeding to fallback...');
      playerWorkingSlotID = {};
      for (let slot of data.initdata.m_syncLobbyState.m_lobbyState.m_slots) {
        let toon = playerLobbyID[slot.m_userId];
        if (toon) {
          playerWorkingSlotID[slot.m_workingSetSlotId] = toon;
        }
      }
    }

    log.debug('Cosmetic use data collection complete');

    // draft bans check
    if (
      match.mode === ReplayTypes.GameMode.UnrankedDraft ||
      match.mode === ReplayTypes.GameMode.HeroLeague ||
      match.mode === ReplayTypes.GameMode.TeamLeague ||
      match.mode === ReplayTypes.GameMode.StormLeague ||
      match.mode === ReplayTypes.GameMode.Custom
    ) {
      log.debug('Gathering draft data...');
      match.bans = { 0: [], 1: [] };
      match.picks = { 0: [], 1: [] };

      let attr = data.attributeevents.scopes['16'];
      for (let a in attr) {
        let obj = attr[a][0];

        // first round bans
        if (obj.attrid === 4023) {
          // team 0 ban 1
          match.bans[0].push({ hero: obj.value, order: 1, absolute: 1 });
        } else if (obj.attrid === 4028) {
          // team 1 ban 1
          match.bans[1].push({ hero: obj.value, order: 1, absolute: 1 });
        }

        if (match.version.m_build < 66292) {
          // prior to build 66292, there were only two bans. in this case, the second ban
          // came in the middle. After this patch, the second ban is actually a first round
          // ban (technically). It will be marked as such.
          if (obj.attrid === 4025) {
            // team 0 ban 2
            match.bans[0].push({ hero: obj.value, order: 2, absolute: 2 });
          } else if (obj.attrid === 4030) {
            // team 1 ban 2
            match.bans[1].push({ hero: obj.value, order: 2, absolute: 2 });
          }
        } else if (match.version.m_build >= 66292) {
          if (obj.attrid === 4025) {
            // team 0 ban 2
            match.bans[0].push({ hero: obj.value, order: 1, absolute: 2 });
          } else if (obj.attrid === 4030) {
            // team 1 ban 2
            match.bans[1].push({ hero: obj.value, order: 1, absolute: 2 });
          }
        }

        // third round bans
        if (obj.attrid === 4043) {
          // team 0 ban 3
          match.bans[0].push({ hero: obj.value, order: 2, absolute: 3 });
        } else if (obj.attrid === 4045) {
          // team 1 ban 3
          match.bans[1].push({ hero: obj.value, order: 2, absolute: 3 });
        }
      }

      // picks
      const pickOrder = { 0: [], 1: [] };
      try {
        for (let e in data.trackerevents) {
          let msg = data.trackerevents[e];

          if (msg._event === 'NNet.Replay.Tracker.SHeroPickedEvent') {
            let player = players[playerWorkingSlotID[msg.m_controllingPlayer]];

            if (!('first' in match.picks)) match.picks.first = player.team;

            // due to swaps, player pick order isn't necessarily correct.
            // also due to this implementation not allowing use of internal hero identifier,
            // we have to do a little extra processing here...
            // record actual player pick order
            pickOrder[player.team].push({
              hero: msg.m_hero,
              id: msg.m_controllingPlayer,
            });
          } else if (msg._event === 'NNet.Replay.Tracker.SHeroSwappedEvent') {
            // find the hero id and assign a new player id
            const player =
              players[playerWorkingSlotID[msg.m_newControllingPlayer]];
            const idx = pickOrder[player.team].findIndex(
              (p) => p.hero === msg.m_hero
            );
            pickOrder[player.team][idx].id = msg.m_newControllingPlayer;
          }
        }
      } catch (e) {
        log.debug('Invalid draft data found, proceeding without draft data...');
        pickOrder[0] = [];
        pickOrder[1] = [];
      }

      // map to hero names
      try {
        match.picks[0] = pickOrder[0].map(
          (p) => players[playerWorkingSlotID[p.id]].hero
        );
        match.picks[1] = pickOrder[1].map(
          (p) => players[playerWorkingSlotID[p.id]].hero
        );
      } catch (e) {
        console.log(`Error processing draft data: ${e}`);
      }

      let a = 1;
      let b = 0;

      // check if Blue Team has first pick
      if (match.picks && match.picks.first === 0) {
        [a, b] = [b, a];
      }

      // create a list of bans and picks in draft order
      let selections = [];

      selections.push(match.bans[a][0]);
      selections.push(match.bans[b][0]);

      // check if the game is from before the second early ban was added
      if (match.version.m_build < 66292) {
        selections.push("N/A");
        selections.push("N/A");
      } else {
        selections.push(match.bans[a][1]);
        selections.push(match.bans[b][1]);
      }

      selections.push(match.picks[a][0]);
      selections.push(match.picks[b][0]);
      selections.push(match.picks[b][1]);
      selections.push(match.picks[a][1]);
      selections.push(match.picks[a][2]);

      // check if the game is from before the second early ban was added
      if (match.version.m_build < 66292) {
        selections.push(match.bans[b][1]);
        selections.push(match.bans[a][1]);
      } else {
        selections.push(match.bans[b][2]);
        selections.push(match.bans[a][2]);
      }

      selections.push(match.picks[b][2]);
      selections.push(match.picks[b][3]);
      selections.push(match.picks[a][3]);
      selections.push(match.picks[a][4]);
      selections.push(match.picks[b][4]);

      // get the slot number for each hero
      for (const [id, player] of Object.entries(players)) {
        player.turn = selections.indexOf(player.hero);
      }

      log.debug('Draft data complete');
    }

    // the tracker events have most of the useful data
    // track a few different kinds of things here, this is probably where most of the interesting stuff will come from
    match.XPBreakdown = [];
    match.takedowns = [];
    match.mercs = { captures: [], units: {} };
    match.team0Takedowns = 0;
    match.team1Takedowns = 0;
    match.structures = {};

    match.objective = { type: match.map };

    // objective object initialization (per-map)
    if (match.map === ReplayTypes.MapType.ControlPoints) {
      match.objective[0] = { count: 0, damage: 0, events: [] };
      match.objective[1] = { count: 0, damage: 0, events: [] };
    } else if (match.map === ReplayTypes.MapType.TowersOfDoom) {
      match.objective.sixTowerEvents = [];
      // this is a special case for towers, other matches will have a general 'structures' object in the root
      match.objective.structures = [];
      match.objective[0] = { count: 0, damage: 0, events: [] };
      match.objective[1] = { count: 0, damage: 0, events: [] };
    } else if (match.map === ReplayTypes.MapType.CursedHollow) {
      match.objective.tributes = [];
      match.objective[0] = { count: 0, events: [] };
      match.objective[1] = { count: 0, events: [] };
    } else if (match.map === ReplayTypes.MapType.DragonShire) {
      // it appears that we can track the status of the shrines based on owner changed events
      var moon = {};
      var sun = {};
      var dragon = null;
      match.objective.shrines = { moon: [], sun: [] };
      match.objective[0] = { count: 0, events: [] };
      match.objective[1] = { count: 0, events: [] };
    } else if (match.map === ReplayTypes.MapType.HauntedWoods) {
      var currentTerror = { 0: {}, 1: {} };
      match.objective[0] = { count: 0, events: [], units: [] };
      match.objective[1] = { count: 0, events: [], units: [] };
    } else if (match.map === ReplayTypes.MapType.HauntedMines) {
      // unfortunately the mines map seems to be missing some older events that had the info about the golem spawns
      // the data would be... tricky to reconstruct due to ambiguity over who picks up the skull
      // we can track when these are summoned though and maybe how long they last
      var golems = [null, null];
      match.objective[0] = [];
      match.objective[1] = [];
    } else if (match.map === ReplayTypes.MapType.BattlefieldOfEternity) {
      var immortal = {};
      match.objective.results = [];
    } else if (match.map === ReplayTypes.MapType.Shrines) {
      // track shrine outcome, and each team's punishers.
      match.objective.shrines = [];
      match.objective[0] = { count: 0, events: [] };
      match.objective[1] = { count: 0, events: [] };
    } else if (match.map === ReplayTypes.MapType.Crypts) {
      var currentSpiders = { units: {}, active: false };
      match.objective[0] = { count: 0, events: [] };
      match.objective[1] = { count: 0, events: [] };
    } else if (match.map === ReplayTypes.MapType.Volskaya) {
      var currentProtector = { active: false };
      match.objective[0] = { count: 0, events: [] };
      match.objective[1] = { count: 0, events: [] };
    } else if (match.map === ReplayTypes.MapType['Warhead Junction']) {
      var nukes = {};
      match.objective[0] = { count: 0, success: 0, events: [] };
      match.objective[1] = { count: 0, success: 0, events: [] };
      match.objective.warheads = [];
    } else if (match.map === ReplayTypes.MapType.AlteracPass) {
      match.objective[0] = { events: [] };
      match.objective[1] = { events: [] };
    } else if (match.map === ReplayTypes.MapType.BraxisHoldout) {
      var waveUnits = { 0: {}, 1: {} };
      var waveID = -1;
      var beacons = {};
      match.objective.beacons = [];
      match.objective.waves = [];
    } else if (match.map === ReplayTypes.MapType.BlackheartsBay) {
      // hopefully something goes here eventually
      match.objective[0] = { count: 0, events: [] };
      match.objective[1] = { count: 0, events: [] };
    } else if (match.map === ReplayTypes.MapType.Hanamura) {
      // can't wait till i have to detect which version of the map this is
      // i mean i guess it doesn't really matter if the old one fails?
      // As of 2.37 this refers to new Hanamura Temple
      // lists payload sequences in order (each object in the array is one payload spawn and completion)
      match.objective = { events: [] };
    } else if (match.map === undefined) {
      log.error('Map name not found. Replay too old?');
      return { status: ReplayStatus.TooOld };
    } else {
      // unsupported map
      log.error('Map ' + match.map + ' is not supported');
      return { status: ReplayStatus.UnsupportedMap };
    }

    var team0XPEnd;
    var team1XPEnd;

    // player 11 = blue (0) team ai?, player 12 = red (0) team ai?
    var possibleMinionXP = { 0: 0, 1: 0 };

    log.debug('[TRACKER] Starting Event Analysis...');

    for (let i = 0; i < tracker.length; i++) {
      let event = tracker[i];

      // case on event type
      if (event._eventid === ReplayTypes.TrackerEvent.Score) {
        // score is real long, separate function
        processScoreArray(event.m_instanceList, match, players, playerIDMap);
      } else if (event._eventid === ReplayTypes.TrackerEvent.Stat) {
        if (
          event.m_eventName === ReplayTypes.StatEventType.EndOfGameTalentChoices
        ) {
          let trackerPlayerID = event.m_intData[0].m_value;
          let playerID = playerIDMap[trackerPlayerID];

          log.trace('[TRACKER] Processing Talent Choices for ' + playerID);

          // this actually contains more than talent choices
          if (event.m_stringData[1].m_value === 'Win') {
            players[playerID].win = true;
          } else {
            players[playerID].win = false;
          }

          players[playerID].internalHeroName = event.m_stringData[0].m_value;

          // talents
          for (let j = 0; j < event.m_stringData.length; j++) {
            if (event.m_stringData[j].m_key.startsWith('Tier')) {
              let key = event.m_stringData[j].m_key;
              if (opts.legacyTalentKeys === true) {
                players[playerID].talents[key] = event.m_stringData[j].m_value;
              } else {
                key = key.replace(/\s+/g, '');
                players[playerID].talents[key] = event.m_stringData[j].m_value;
              }
            }
          }
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.PeriodicXPBreakdown
        ) {
          // periodic xp breakdown
          let xpb = {};
          xpb.loop = event._gameloop;
          xpb.time = loopsToSeconds(xpb.loop - match.loopGameStart);
          xpb.team = event.m_intData[0].m_value - 1; // team is 1-indexed in this event?
          xpb.teamLevel = event.m_intData[1].m_value;
          xpb.breakdown = {};
          xpb.theoreticalMinionXP = possibleMinionXP[xpb.team];

          log.trace(
            '[TRACKER] Processing XP Breakdown for team ' +
              xpb.team +
              ' at loop ' +
              xpb.loop
          );

          for (let j in event.m_fixedData) {
            xpb.breakdown[event.m_fixedData[j].m_key] =
              event.m_fixedData[j].m_value / 4096;
          }

          match.XPBreakdown.push(xpb);
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.EndOfGameXPBreakdown
        ) {
          // end of game xp breakdown
          let xpb = {};
          xpb.loop = event._gameloop;
          xpb.time = loopsToSeconds(xpb.loop - match.loopGameStart);
          xpb.team = players[playerIDMap[event.m_intData[0].m_value]].team;
          xpb.theoreticalMinionXP = possibleMinionXP[xpb.team];
          xpb.breakdown = {};

          log.trace(
            '[TRACKER] Caching Final XP Breakdown for team ' +
              xpb.team +
              ' at loop ' +
              xpb.loop
          );

          for (let j in event.m_fixedData) {
            xpb.breakdown[event.m_fixedData[j].m_key] =
              event.m_fixedData[j].m_value / 4096;
          }

          if (xpb.team === ReplayTypes.TeamType.Blue) {
            team0XPEnd = xpb;
          } else if (xpb.team === ReplayTypes.TeamType.Red) {
            team1XPEnd = xpb;
          }
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.PlayerDeath
        ) {
          // add data to the match and the individual players
          let tData = {};
          tData.loop = event._gameloop;
          tData.time = loopsToSeconds(tData.loop - match.loopGameStart);
          tData.x = event.m_fixedData[0].m_value;
          tData.y = event.m_fixedData[1].m_value;
          tData.killers = [];

          // player ids
          let victim;
          let killers = [];

          for (let j = 0; j < event.m_intData.length; j++) {
            let entry = event.m_intData[j];

            if (entry.m_key === 'PlayerID') {
              tData.victim = {
                player: playerIDMap[entry.m_value],
                hero: players[playerIDMap[entry.m_value]].hero,
              };
              victim = playerIDMap[entry.m_value];
            } else if (entry.m_key === 'KillingPlayer') {
              let tdo = {};
              if (!(entry.m_value in playerIDMap)) {
                // this poor person died to a creep
                tdo.player = '0';
                tdo.hero = 'Nexus Forces';
              } else {
                tdo = {
                  player: playerIDMap[entry.m_value],
                  hero: players[playerIDMap[entry.m_value]].hero,
                };
              }

              killers.push(playerIDMap[entry.m_value]);
              tData.killers.push(tdo);
            }
          }

          if (players[victim].team === ReplayTypes.TeamType.Blue)
            match.team1Takedowns += 1;
          else if (players[victim].team === ReplayTypes.TeamType.Red)
            match.team0Takedowns += 1;

          match.takedowns.push(tData);
          players[victim].deaths.push(tData);
          for (let j = 0; j < killers.length; j++) {
            if (killers[j] === undefined) continue;

            players[killers[j]].takedowns.push(tData);
          }

          log.trace(
            '[TRACKER] Processed Player ' + victim + ' death at ' + tData.loop
          );
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.LootSprayUsed
        ) {
          let spray = {};
          let id = event.m_stringData[1].m_value;
          spray.kind = event.m_stringData[2].m_value;
          spray.x = event.m_fixedData[0].m_value;
          spray.y = event.m_fixedData[1].m_value;
          spray.loop = event._gameloop;
          spray.time = loopsToSeconds(spray.loop - match.loopGameStart);
          spray.kills = 0;
          spray.deaths = 0;

          players[id].sprays.push(spray);

          log.trace('[TRACKER] Spray from player ' + id + ' found');
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.LootVoiceLineUsed
        ) {
          let line = {};
          let id = event.m_stringData[1].m_value;
          line.kind = event.m_stringData[2].m_value;
          line.x = event.m_fixedData[0].m_value;
          line.y = event.m_fixedData[1].m_value;
          line.loop = event._gameloop;
          line.time = loopsToSeconds(line.loop - match.loopGameStart);
          line.kills = 0;
          line.deaths = 0;

          players[id].voiceLines.push(line);

          log.trace('[TRACKER] Voice Line from player ' + id + ' found');
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.SkyTempleShotsFired
        ) {
          let objEvent = {
            team: event.m_intData[2].m_value - 1,
            loop: event._gameloop,
            damage: event.m_fixedData[0].m_value / 4096,
          };
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);

          if (objEvent.team === 0 || objEvent.team === 1) {
            match.objective[objEvent.team].events.push(objEvent);
            match.objective[objEvent.team].damage += objEvent.damage;
            match.objective[objEvent.team].count += 1;
          }

          log.trace(
            '[TRACKER] Sky Temple: Shot fired for team ' + objEvent.team
          );
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.AltarCaptured
        ) {
          let objEvent = {
            team: event.m_intData[0].m_value - 1,
            loop: event._gameloop,
            owned: event.m_intData[1].m_value,
          };
          objEvent.damage = objEvent.owned + 1;
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);

          match.objective[objEvent.team].events.push(objEvent);
          match.objective[objEvent.team].damage += objEvent.damage;
          match.objective[objEvent.team].count += 1;

          log.trace(
            '[TRACKER] Towers of Doom: Altar Capture for team ' + objEvent.team
          );
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.ImmortalDefeated
        ) {
          let objEvent = {
            winner: event.m_intData[1].m_value - 1,
            loop: event._gameloop,
            duration: event.m_intData[2].m_value,
          };
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);
          objEvent.power = event.m_fixedData[0].m_value / 4096;

          log.trace('[TRACKER] Immortal Fight Completed');

          match.objective.results.push(objEvent);
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.TributeCollected
        ) {
          let objEvent = {
            team: event.m_fixedData[0].m_value / 4096 - 1,
            loop: event._gameloop,
          };
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);

          match.objective[objEvent.team].events.push(objEvent);
          match.objective[objEvent.team].count += 1;

          log.trace('[TRACKER] Tribute collected by team ' + objEvent.team);
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.DragonKnightActivated
        ) {
          let objEvent = {
            team: event.m_fixedData[0].m_value / 4096 - 1,
            loop: event._gameloop,
          };
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);

          match.objective[objEvent.team].events.push(objEvent);
          match.objective[objEvent.team].count += 1;
          dragon.team = objEvent.team;

          log.trace(
            '[TRACKER] Dragon Knight Activated by team ' + objEvent.team
          );
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.GardenTerrorActivated
        ) {
          let objEvent = {
            team: event.m_fixedData[1].m_value / 4096 - 1,
            loop: event._gameloop,
          };
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);

          match.objective[objEvent.team].events.push(objEvent);
          match.objective[objEvent.team].count += 1;
          currentTerror[objEvent.team].active = true;

          log.trace(
            '[TRACKER] Garden Terror Activated by team ' + objEvent.team
          );
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.ShrineCaptured
        ) {
          let objEvent = {
            team: event.m_intData[1].m_value - 1,
            loop: event._gameloop,
          };
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);
          objEvent.team0Score =
            objEvent.team === 0
              ? event.m_intData[2].m_value
              : event.m_intData[3].m_value;
          objEvent.team1Score =
            objEvent.team === 1
              ? event.m_intData[2].m_value
              : event.m_intData[3].m_value;

          match.objective.shrines.push(objEvent);

          log.trace('[TRACKER] Shrine won by team ' + objEvent.team);
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.PunisherKilled
        ) {
          let objEvent = {
            team: event.m_intData[1].m_value - 1,
            loop: event._gameloop,
            type: event.m_stringData[0].m_value,
          };
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);
          objEvent.duration = event.m_intData[2].m_value;
          objEvent.siegeDamage = event.m_fixedData[0].m_value / 4096;
          objEvent.heroDamage = event.m_fixedData[1].m_value / 4096;

          match.objective[objEvent.team].events.push(objEvent);
          match.objective[objEvent.team].count += 1;

          log.trace('[TRACKER] Punisher defeated');
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.SpidersSpawned
        ) {
          let objEvent = {
            team: event.m_fixedData[0].m_value / 4096 - 1,
            score: event.m_intData[1].m_value,
            loop: event._gameloop,
          };
          objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);
          currentSpiders.active = true;
          currentSpiders.team = objEvent.team;

          match.objective[objEvent.team].events.push(objEvent);
          match.objective[objEvent.team].count += 1;
          currentSpiders.eventIdx = match.objective[objEvent.team].count - 1;
          currentSpiders.unitIdx = 0;

          log.trace(
            '[TRACKER] Webweaver phase for team ' + objEvent.team + ' started'
          );
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.CampCapture
        ) {
          let cap = {
            loop: event._gameloop,
            type: event.m_stringData[0].m_value,
            team: event.m_fixedData[0].m_value / 4096 - 1,
          };
          cap.time = loopsToSeconds(cap.loop - match.loopGameStart);
          match.mercs.captures.push(cap);

          if (match.map === ReplayTypes.MapType.TowersOfDoom) {
            if (cap.type === 'Boss Camp') {
              let bossEvent = {
                team: cap.team,
                loop: cap.loop,
                time: cap.time,
                type: 'boss',
                damage: 4,
              };
              match.objective[cap.team].events.push(bossEvent);
              match.objective[cap.team].damage += bossEvent.damage;
              match.objective[cap.team].count += 1;
            }
          }

          log.trace(
            '[TRACKER] Mercenary camp captured by team ' +
              cap.team +
              ' of type ' +
              cap.type
          );
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.SixTowersStart
        ) {
          let six = {
            loop: event._gameloop,
            team: event.m_intData[0].m_value - 1,
            kind: 'capture',
          };
          six.time = loopsToSeconds(six.loop - match.loopGameStart);

          match.objective.sixTowerEvents.push(six);
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.SixTowersEnd
        ) {
          let six = {
            loop: event._gameloop,
            team: event.m_intData[0].m_value - 1,
            kind: 'end',
          };
          six.time = loopsToSeconds(six.loop - match.loopGameStart);

          match.objective.sixTowerEvents.push(six);
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.TowersFortCaptured
        ) {
          let fort = {
            loop: event._gameloop,
            ownedBy: event.m_intData[0].m_value - 11,
          };
          fort.time = loopsToSeconds(fort.loop - match.loopGameStart);
          match.objective.structures.push(fort);
        } else if (event.m_eventName === ReplayTypes.StatEventType.LevelUp) {
          // just kinda dump this all into the object. the only important data is the time.
          let lobj = {
            loop: event._gameloop,
            level: event.m_intData[1].m_value,
          };
          // team is mapped by player
          lobj.team = players[playerIDMap[event.m_intData[0].m_value]].team;
          lobj.time = loopsToSeconds(event._gameloop - match.loopGameStart);

          match.levelTimes[lobj.team][lobj.level] = lobj;
        } else if (event.m_eventName === ReplayTypes.StatEventType.Upvote) {
          let targetPlayer = event.m_intData[0].m_value;
          players[playerIDMap[targetPlayer]].votes = event.m_intData[2].m_value;
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.RegenGlobePickedUp
        ) {
          let globe = {
            loop: event._gameloop,
            time: loopsToSeconds(event._gameloop - match.loopGameStart),
          };
          let id = playerIDMap[event.m_intData[0].m_value];
          players[id].globes.count += 1;
          players[id].globes.events.push(globe);
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.BraxisWaveStart
        ) {
          match.objective.waves[waveID].startLoop = event._gameloop;
          match.objective.waves[waveID].startTime = loopsToSeconds(
            event._gameloop - match.loopGameStart
          );

          match.objective.waves[waveID].startScore = {
            0: event.m_fixedData[0].m_value / 4096,
            1: event.m_fixedData[1].m_value / 4096,
          };
        } else if (
          event.m_eventName === ReplayTypes.StatEventType.GhostShipCaptured
        ) {
          let team = event.m_fixedData[0].m_value / 4096 - 1;
          match.objective[team].events.push({
            loop: event._gameloop,
            time: loopsToSeconds(event._gameloop - match.loopGameStart),
            team: team,
            teamScore: event.m_intData[0].m_value,
            otherScore: event.m_intData[1].m_value,
          });
          match.objective[team].count += 1;
        }
      } else if (event._eventid === ReplayTypes.TrackerEvent.UnitBorn) {
        // there's going to be a special case for tomb once i figure out the map name for it
        // unit type
        let type = event.m_unitTypeName;

        // if it's a minion...
        if (type in ReplayTypes.MinionXP) {
          let elapsedGameMinutes = parseInt(
            loopsToSeconds(event._gameloop - match.loopGameStart) / 60
          );

          if (elapsedGameMinutes > 30) elapsedGameMinutes = 30;

          let xpVal = ReplayTypes.MinionXP[type][elapsedGameMinutes];

          if (match.map === ReplayTypes.MapType.Crypts) {
            xpVal = ReplayTypes.TombMinionXP[type][elapsedGameMinutes];
          }

          if (event.m_upkeepPlayerId === 11)
            possibleMinionXP[ReplayTypes.TeamType.Blue] += xpVal;
          else if (event.m_upkeepPlayerId === 12)
            possibleMinionXP[ReplayTypes.TeamType.Red] += xpVal;
        } else if (type === ReplayTypes.UnitType.MinesBoss) {
          let spawn = {
            loop: event._gameloop,
            team: event.m_controlPlayerId - 11,
          };
          spawn.time = loopsToSeconds(spawn.loop - match.loopGameStart);
          spawn.unitTagIndex = event.m_unitTagIndex;
          spawn.unitTagRecycle = event.m_unitTagRecycle;

          golems[spawn.team] = spawn;
        } else if (type === ReplayTypes.UnitType.RavenLordTribute) {
          let spawn = { loop: event._gameloop };
          spawn.x = event.m_x;
          spawn.y = event.m_y;
          spawn.time = loopsToSeconds(spawn.loop - match.loopGameStart);

          match.objective.tributes.push(spawn);
        } else if (type === ReplayTypes.UnitType.MoonShrine) {
          moon = { tag: event.m_unitTagIndex, rtag: event.m_unitTagRecycle };
        } else if (type === ReplayTypes.UnitType.SunShrine) {
          sun = { tag: event.m_unitTagIndex, rtag: event.m_unitTagRecycle };
        } else if (type === ReplayTypes.UnitType.GardenTerrorVehicle) {
          let spawn = {
            team: event.m_upkeepPlayerId - 11,
            active: false,
            tag: event.m_unitTagIndex,
            rtag: event.m_unitTagRecycle,
          };

          currentTerror[spawn.team] = spawn;
        } else if (type === ReplayTypes.UnitType.GardenTerror) {
          let unit = {
            team: event.m_upkeepPlayerId - 11,
            tag: event.m_unitTagIndex,
            rtag: event.m_unitTagRecycle,
            time: loopsToSeconds(event._gameloop - match.loopGameStart),
            loop: event._gameloop,
          };

          match.objective[unit.team].units.push(unit);
        } else if (type === ReplayTypes.UnitType.DragonVehicle) {
          // current dragon knight spawn
          dragon = { tag: event.m_unitTagIndex, rtag: event.m_unitTagRecycle };
        } else if (type === ReplayTypes.UnitType.Webweaver) {
          // dump some spiders in
          let spider = {
            tag: event.m_unitTagIndex,
            rtag: event.m_unitTagRecycle,
            x: event.m_x,
            y: event.m_y,
          };
          spider.loop = event._gameloop;
          spider.time = loopsToSeconds(spider.loop - match.loopGameStart);

          currentSpiders.units[currentSpiders.unitIdx] = spider;
          currentSpiders.unitIdx += 1;
        } else if (type === ReplayTypes.UnitType.Triglav) {
          currentProtector = {
            tag: event.m_unitTagIndex,
            rtag: event.m_unitTagRecycle,
            team: event.m_upkeepPlayerId - 11,
            loop: event._gameloop,
          };
          currentProtector.x = event.m_x;
          currentProtector.y = event.m_y;
          currentProtector.time = loopsToSeconds(
            currentProtector.loop - match.loopGameStart
          );
          currentProtector.active = true;

          // add to objectives array, can ref later
          match.objective[currentProtector.team].events.push(currentProtector);
          match.objective[currentProtector.team].count += 1;
          currentProtector.eventIdx =
            match.objective[currentProtector.team].count - 1;

          log.trace(
            '[TRACKER] Triglav Protector spawned by team ' +
              currentProtector.team
          );
        } else if (type === ReplayTypes.UnitType.Nuke) {
          // create an id for the unit
          let id = event.m_unitTagIndex + '-' + event.m_unitTagRecycle;
          let eventObj = {
            tag: event.m_unitTagIndex,
            rtag: event.m_unitTagRecycle,
            loop: event._gameloop,
            x: event.m_x,
            y: event.m_y,
          };
          eventObj.time = loopsToSeconds(eventObj.loop - match.loopGameStart);
          eventObj.player = playerIDMap[event.m_controlPlayerId];
          eventObj.team = eventObj.player
            ? players[eventObj.player].team
            : event.m_upkeepPlayerId - 11;

          nukes[id] = eventObj;
        } else if (type in ReplayTypes.BraxisUnitType) {
          // add things to the waves, these objects get reset when the wave launches
          let id = event.m_unitTagIndex + '-' + event.m_unitTagRecycle;
          let eventObj = {
            tag: event.m_unitTagIndex,
            rtag: event.m_unitTagRecycle,
            loop: event._gameloop,
            x: event.m_x,
            y: event.m_y,
          };
          eventObj.team = event.m_controlPlayerId - 11;
          eventObj.time = loopsToSeconds(eventObj.loop - match.loopGameStart);
          eventObj.type = event.m_unitTypeName;

          if (
            Object.keys(waveUnits[0]).length === 0 &&
            Object.keys(waveUnits[1]).length === 0
          ) {
            // init a new wave tracker object
            waveID += 1;
            // events includes beacon ownership events, scores include score over time, which can be updated any time
            // a new unit gets spawned for the current wave
            let waveObj = {
              initLoop: event._gameloop,
              initTime: eventObj.time,
              scores: [],
              endLoop: { 0: 0, 1: 0 },
              endTime: { 0: 0, 1: 0 },
            };
            waveObj.scores.push({
              loop: event._gameloop,
              time: eventObj.time,
              0: 0,
              1: 0,
            });
            match.objective.waves.push(waveObj);
          } else {
            let score = {
              0: braxisWaveStrength(waveUnits[0], match.version.m_build),
              1: braxisWaveStrength(waveUnits[1], match.version.m_build),
            };
            score.loop = event._gameloop;
            score.time = loopsToSeconds(score.loop - match.loopGameStart);
            match.objective.waves[waveID].scores.push(score);
          }

          waveUnits[eventObj.team][id] = eventObj;
        } else if (type === ReplayTypes.UnitType.BraxisZergPath) {
          // start the wave
          if (!match.objective.waves[waveID].startLoop) {
            match.objective.waves[waveID].startLoop = event._gameloop;
            match.objective.waves[waveID].startTime = loopsToSeconds(
              event._gameloop - match.loopGameStart
            );

            match.objective.waves[waveID].startScore = {
              0: braxisWaveStrength(waveUnits[0], match.version.m_build),
              1: braxisWaveStrength(waveUnits[1], match.version.m_build),
            };
          }
        } else if (type === ReplayTypes.UnitType.BraxisControlPoint) {
          let id = event.m_unitTagIndex + '-' + event.m_unitTagRecycle;
          let y = event.m_y;
          beacons[id] = {
            tag: event.m_unitTagIndex,
            rtag: event.m_unitTagRecycle,
            side: y > 100 ? 'top' : 'bottom',
          };
        } else if (
          type === ReplayTypes.UnitType.ImmortalHeaven ||
          type === ReplayTypes.UnitType.ImmortalHell
        ) {
          immortal.start = event._gameloop;
          immortal.tag = event.m_unitTagIndex;
          immortal.rtag = event.m_unitTagRecycle;
        } else if (type === ReplayTypes.UnitType.WarheadSpawn) {
          let eventObj = {
            loop: event._gameloop,
            type: 'spawn',
            x: event.m_x,
            y: event.m_y,
          };
          eventObj.time = loopsToSeconds(eventObj.loop - match.loopGameStart);
          match.objective.warheads.push(eventObj);
        } else if (type === ReplayTypes.UnitType.WarheadDropped) {
          let eventObj = {
            loop: event._gameloop,
            type: 'dropped',
            x: event.m_x,
            y: event.m_y,
          };
          eventObj.time = loopsToSeconds(eventObj.loop - match.loopGameStart);
          match.objective.warheads.push(eventObj);
        } else if (
          type === ReplayTypes.UnitType.AllianceCavalry ||
          type === ReplayTypes.UnitType.HordeCavalry
        ) {
          const eventObj = {
            loop: event._gameloop,
            born: loopsToSeconds(event._gameloop - match.loopGameStart),
            id: event.m_unitTagIndex + '-' + event.m_unitTagRecycle,
          };
          match.objective[event.m_controlPlayerId - 11].events.push(eventObj);
        } else if (type === ReplayTypes.UnitType.NeutralPayload) {
          const eventObj = {
            loop: event._gameloop,
            born: loopsToSeconds(event._gameloop - match.loopGameStart),
            id: `${event.m_unitTagIndex}-${event.m_unitTagRecycle}`,
            control: [
              {
                team: -1,
                loop: event._gameloop,
                time: loopsToSeconds(event._gameloop - match.loopGameStart),
              },
            ],
          };
          match.objective.events.push(eventObj);
        } else if (type in ReplayTypes.MercUnitType) {
          // mercs~
          let id = event.m_unitTagIndex + '-' + event.m_unitTagRecycle;
          let unit = {
            loop: event._gameloop,
            team: event.m_controlPlayerId - 11,
            type: event.m_unitTypeName,
            locations: [
              {
                x: event.m_x,
                y: event.m_y,
              },
            ],
          };
          unit.time = loopsToSeconds(unit.loop - match.loopGameStart);
          match.mercs.units[id] = unit;

          log.trace(
            '[MERCS] id:' +
              id +
              ' ' +
              unit.type +
              ' spawned for team ' +
              unit.team
          );
        } else if (type in ReplayTypes.StructureStrings) {
          let id = event.m_unitTagIndex + '-' + event.m_unitTagRecycle;
          let str = {
            type,
            name: ReplayTypes.StructureStrings[type],
            tag: event.m_unitTagIndex,
            rtag: event.m_unitTagRecycle,
            x: event.m_x,
            y: event.m_y,
          };
          str.team = event.m_controlPlayerId - 11;
          match.structures[id] = str;
        } else if (type.startsWith('Hero')) {
          // there are a few special cases that get skipped (see: lost vikings)
          // TLV spawns a special controller for all of the three heroes, but isn't a targetable unit
          if (type === 'HeroLostVikingsController') {
            continue;
          }

          // check for valid player
          if (event.m_controlPlayerId in playerIDMap) {
            // hero spawn
            const id = `${event.m_unitTagIndex}-${event.m_unitTagRecycle}`;
            const playerID = playerIDMap[event.m_controlPlayerId];
            players[playerID].units[id] = {
              lives: [],
              name: type,
            };
            players[playerID].units[id].lives.push({
              born: loopsToSeconds(event._gameloop - match.loopGameStart),
              locations: [
                {
                  x: event.m_x,
                  y: event.m_y,
                  time: loopsToSeconds(event._gameloop - match.loopGameStart),
                },
              ],
            });
          }
        }
      } else if (event._eventid === ReplayTypes.TrackerEvent.UnitRevived) {
        // heroes, all maps
        const uid = `${event.m_unitTagIndex}-${event.m_unitTagRecycle}`;

        for (const pid in playerIDMap) {
          const player = players[playerIDMap[pid]];
          if (uid in player.units) {
            player.units[uid].lives.push({
              born: loopsToSeconds(event._gameloop - match.loopGameStart),
              locations: [
                {
                  x: event.m_x,
                  y: event.m_y,
                  time: loopsToSeconds(event._gameloop - match.loopGameStart),
                },
              ],
            });
          }
        }
      } else if (event._eventid === ReplayTypes.TrackerEvent.UnitPositions) {
        // get first index
        let unitIndex = event.m_firstUnitIndex;
        for (let i = 0; i < event.m_items.length; i += 3) {
          // check players to see if unit index is present (players don't appear to get recycled,
          // so tag index should be fine)
          unitIndex += event.m_items[i];
          let x = event.m_items[i + 1];
          let y = event.m_items[i + 2];

          for (const pid in playerIDMap) {
            const player = players[playerIDMap[pid]];
            for (const uid in player.units) {
              if (uid.startsWith(unitIndex)) {
                const currentLife =
                  player.units[uid].lives[player.units[uid].lives.length - 1];
                currentLife.locations.push({
                  x,
                  y,
                  time: loopsToSeconds(event._gameloop - match.loopGameStart),
                });
              }
            }
          }

          // check mercs
          // mercs need check that a) the index matches, and b) unit is alive (non-recycled)
          for (const mercID in match.mercs.units) {
            if (mercID.startsWith(unitIndex)) {
              // if duration is present, it died
              if (!match.mercs.units[mercID].duration) {
                match.mercs.units[mercID].locations.push({ x, y });
              }
            }
          }
        }
      } else if (event._eventid === ReplayTypes.TrackerEvent.UnitDied) {
        let tag = event.m_unitTagIndex;
        let rtag = event.m_unitTagRecycle;

        let uid = tag + '-' + rtag;

        // cores
        if (uid in cores) {
          match.loopLength = event._gameloop;
          match.length = loopsToSeconds(match.loopLength - match.loopGameStart);
        }

        // mercs, all maps
        if (uid in match.mercs.units) {
          match.mercs.units[uid].duration = loopsToSeconds(
            event._gameloop - match.mercs.units[uid].loop
          );
          match.mercs.units[uid].locations.push({
            x: event.m_x,
            y: event.m_y,
          });

          log.trace('[MERCS] Mercenary id ' + uid + ' died');
        }

        // structures, all maps
        if (uid in match.structures) {
          match.structures[uid].destroyedLoop = event._gameloop;
          match.structures[uid].destroyed = loopsToSeconds(
            event._gameloop - match.loopGameStart
          );

          log.trace(
            '[STRUCTURES] Team ' +
              match.structures[uid].team +
              ' ' +
              match.structures[uid].type +
              ' destroyed'
          );
        }

        // heroes, all maps
        for (const pid in playerIDMap) {
          const player = players[playerIDMap[pid]];
          if (uid in player.units) {
            const currentLife =
              player.units[uid].lives[player.units[uid].lives.length - 1];
            currentLife.died = loopsToSeconds(
              event._gameloop - match.loopGameStart
            );
            currentLife.duration = currentLife.died - currentLife.born;
            currentLife.locations.push({
              x: event.m_x,
              y: event.m_y,
              time: currentLife.died,
            });
          }
        }

        // Haunted Mines - check for matching golem death
        if (match.map === ReplayTypes.MapType.HauntedMines) {
          for (let g in golems) {
            let golem = golems[g];

            if (
              golem &&
              golem.unitTagIndex === tag &&
              golem.unitTagRecycle === rtag
            ) {
              let objEvent = {
                startLoop: golem.loop,
                startTime: golem.time,
                endLoop: event._gameloop,
              };
              objEvent.endTime = loopsToSeconds(
                objEvent.endLoop - match.loopGameStart
              );
              objEvent.duration = objEvent.endTime - objEvent.startTime;
              objEvent.team = golem.team;
              golems[g] = null;

              log.trace(
                '[TRACKER] Team ' +
                  objEvent.team +
                  ' golem lasted for ' +
                  objEvent.duration +
                  ' seconds'
              );

              match.objective[objEvent.team].push(objEvent);
            }
          }
        } else if (match.map === ReplayTypes.MapType.HauntedWoods) {
          // check plant death
          for (let t in currentTerror) {
            let terror = currentTerror[t];

            if (terror.active && terror.tag === tag && terror.rtag === rtag) {
              let team = parseInt(t);
              let duration =
                event._gameloop -
                match.objective[team].events[
                  match.objective[team].events.length - 1
                ].loop;
              match.objective[team].events[
                match.objective[team].events.length - 1
              ].loopDuration = duration;
              match.objective[team].events[
                match.objective[team].events.length - 1
              ].duration = loopsToSeconds(duration);
              match.objective[team].events[
                match.objective[team].events.length - 1
              ].player = terror.player;

              currentTerror[t].active = false;

              log.trace(
                '[TRACKER] Team ' +
                  team +
                  ' terror lasted for ' +
                  loopsToSeconds(duration) +
                  ' seconds'
              );
            }
          }

          // check terror death
          for (let t in match.objective) {
            let units = match.objective[t].units;
            for (let ui in units) {
              let u = units[ui];
              let tid = `${u.tag}-${u.rtag}`;

              if (tid === uid) {
                u.end = loopsToSeconds(event._gameloop - match.loopGameStart);
                u.duration = u.end - u.start;
              }
            }
          }
        } else if (match.map === ReplayTypes.MapType.DragonShire) {
          if (dragon && dragon.tag === tag && dragon.rtag === rtag) {
            // log duration
            let lastIdx = match.objective[dragon.team].events.length - 1;
            match.objective[dragon.team].events[lastIdx].loopDuration =
              event._gameloop -
              match.objective[dragon.team].events[lastIdx].loop;
            match.objective[dragon.team].events[
              lastIdx
            ].duration = loopsToSeconds(
              match.objective[dragon.team].events[lastIdx].loopDuration
            );
            match.objective[dragon.team].events[lastIdx].player = dragon.player;

            dragon = null;
          }
        } else if (match.map === ReplayTypes.MapType.Crypts) {
          if (currentSpiders.active) {
            for (let s in currentSpiders.units) {
              let spider = currentSpiders.units[s];

              if (tag === spider.tag && rtag === spider.rtag) {
                currentSpiders.maxDuration = loopsToSeconds(
                  event._gameloop - spider.loop
                );

                // hey so like this is a removal of a key during iteration but i think it's
                delete currentSpiders.units[s];
                if (Object.keys(currentSpiders.units).length === 0) {
                  // all webweavers died, clean up data
                  match.objective[currentSpiders.team].events[
                    currentSpiders.eventIdx
                  ].duration = currentSpiders.maxDuration;
                  match.objective[currentSpiders.team].events[
                    currentSpiders.eventIdx
                  ].endLoop = event._gameloop;
                  match.objective[currentSpiders.team].events[
                    currentSpiders.eventIdx
                  ].end = loopsToSeconds(event._gameloop - match.loopGameStart);
                  currentSpiders.active = false;
                  currentSpiders.units = {};

                  log.trace('[TRACKER] Webweaver phase ended');
                  break;
                }
              }
            }
          }
        } else if (match.map === ReplayTypes.MapType.Volskaya) {
          // checking for protector death
          if (
            currentProtector.active &&
            currentProtector.tag === tag &&
            currentProtector.rtag === rtag
          ) {
            // it ded
            let duration = loopsToSeconds(
              event._gameloop - currentProtector.loop
            );
            match.objective[currentProtector.team].events[
              currentProtector.eventIdx
            ].duration = duration;
            currentProtector = { active: false };

            log.trace('[TRACKER] Triglav Protector destroyed');
          }
        } else if (match.map === ReplayTypes.MapType['Warhead Junction']) {
          let id = tag + '-' + rtag;

          if (id in nukes) {
            nukes[id].success = event._gameloop - nukes[id].loop > 16 * 2;

            log.trace('[TRACKER] Nuclear Launch Detected');
          }
        } else if (match.map === ReplayTypes.MapType.BraxisHoldout) {
          let id = tag + '-' + rtag;

          if (id in waveUnits[0]) {
            if (
              waveUnits[0][id].type === ReplayTypes.BraxisUnitType.ZergUltralisk
            ) {
              // this i think isn't relevant since build 66488
              // ok so if an ultralisk died and the killer was null, then we have to update
              // the starting strength of the other team's wave to 1 because this unit got
              // dead instantly
              if (event.m_killerPlayerId === null) {
                if (!('startScore' in match.objective.waves[waveID])) {
                  match.objective.waves[waveID].startScore = {
                    0: braxisWaveStrength(waveUnits[0], match.version.m_build),
                    1: braxisWaveStrength(waveUnits[1], match.version.m_build),
                  };
                }
                match.objective.waves[waveID].startScore[1] = 100;
              }
            }

            match.objective.waves[waveID].endLoop[0] = event._gameloop;
            match.objective.waves[waveID].endTime[0] = loopsToSeconds(
              event._gameloop - match.loopGameStart
            );
            delete waveUnits[0][id];
          } else if (id in waveUnits[1]) {
            if (
              waveUnits[1][id].type === ReplayTypes.BraxisUnitType.ZergUltralisk
            ) {
              // ok so if an ultralisk died and the killer was null, then we have to update
              // the starting strength of the other team's wave to 1 because this unit got
              // dead instantly
              if (event.m_killerPlayerId === null) {
                if (!('startScore' in match.objective.waves[waveID])) {
                  match.objective.waves[waveID].startScore = {
                    0: braxisWaveStrength(waveUnits[0], match.version.m_build),
                    1: braxisWaveStrength(waveUnits[1], match.version.m_build),
                  };
                }

                match.objective.waves[waveID].startScore[0] = 100;
              }
            }
            match.objective.waves[waveID].endLoop[1] = event._gameloop;
            match.objective.waves[waveID].endTime[1] = loopsToSeconds(
              event._gameloop - match.loopGameStart
            );
            delete waveUnits[1][id];
          }
        } else if (match.map === ReplayTypes.MapType.BattlefieldOfEternity) {
          if ('tag' in immortal) {
            if (tag === immortal.tag && rtag === immortal.rtag) {
              // append duration to last result
              let res = match.objective.results.length - 1;
              match.objective.results[res].immortalDuration = loopsToSeconds(
                event._gameloop - immortal.start
              );
              immortal = {};
            }
          }
        } else if (match.map === ReplayTypes.MapType.AlteracPass) {
          // search for unit to mark time of death
          for (let i of [0, 1]) {
            let units = match.objective[i].events;
            for (let j in units) {
              if (units[j].id === uid) {
                units[j].died = loopsToSeconds(
                  event._gameloop - match.loopGameStart
                );
              }
            }
          }
        } else if (match.map === ReplayTypes.MapType.Hanamura) {
          // should be the most recent thing
          let payload =
            match.objective.events[match.objective.events.length - 1];

          if (payload && payload.id === uid) {
            payload.died = loopsToSeconds(
              event._gameloop - match.loopGameStart
            );
            payload.winner = payload.control[payload.control.length - 1].team;

            log.trace(`Payload ${uid} died, winner ${payload.winner}`);
          }
        }
      } else if (event._eventid === ReplayTypes.TrackerEvent.UnitOwnerChange) {
        if (match.map === ReplayTypes.MapType.DragonShire) {
          // dragon shire shrine control
          // actually you can probably track this on braxis too huh
          let tag = event.m_unitTagIndex;
          let rtag = event.m_unitTagRecycle;
          let team = event.m_controlPlayerId;

          if (moon.tag === tag && moon.rtag === rtag) {
            let objEvent = { loop: event._gameloop, team };
            objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);

            if (objEvent.team !== 0) objEvent.team -= 11;
            else objEvent.team = -1; // oops have to indicate no team, but our blue team is already 0

            match.objective.shrines.moon.push(objEvent);
          } else if (sun.tag === tag && sun.rtag === rtag) {
            let objEvent = { loop: event._gameloop, team };
            objEvent.time = loopsToSeconds(objEvent.loop - match.loopGameStart);

            if (objEvent.team !== 0) objEvent.team -= 11;
            else objEvent.team = -1;

            match.objective.shrines.sun.push(objEvent);
          } else if (dragon && dragon.tag === tag && dragon.rtag === rtag) {
            // player got it
            if (
              event.m_controlPlayerId > 0 &&
              event.m_controlPlayerId !== 11 &&
              event.m_controlPlayerId !== 12
            ) {
              dragon.player = playerIDMap[event.m_controlPlayerId];
            }
          }
        }
        if (match.map === ReplayTypes.MapType.HauntedWoods) {
          let tag = event.m_unitTagIndex;
          let rtag = event.m_unitTagRecycle;

          for (let t in currentTerror) {
            let terror = currentTerror[t];

            if (terror.tag === tag && terror.rtag === rtag) {
              currentTerror[t].player = playerIDMap[event.m_controlPlayerId];
            }
          }
        }
        if (match.map === ReplayTypes.MapType.BraxisHoldout) {
          let tag = event.m_unitTagIndex;
          let rtag = event.m_unitTagRecycle;
          let id = tag + '-' + rtag;

          if (id in beacons) {
            let team =
              event.m_controlPlayerId === 0 ? -1 : event.m_controlPlayerId - 11;
            let beaconEvent = {
              team,
              loop: event._gameloop,
              side: beacons[id].side,
            };
            beaconEvent.time = loopsToSeconds(
              event._gameloop - match.loopGameStart
            );

            match.objective.beacons.push(beaconEvent);
          }
        }
        if (match.map === ReplayTypes.MapType.Hanamura) {
          const id = `${event.m_unitTagIndex}-${event.m_unitTagRecycle}`;
          let payload =
            match.objective.events[match.objective.events.length - 1];

          if (payload && payload.id === id) {
            let team =
              event.m_controlPlayerId === 0 ? -1 : event.m_controlPlayerId - 11;
            payload.control.push({
              team,
              loop: event._gameloop,
              time: loopsToSeconds(event._gameloop - match.loopGameStart),
            });
          }
        }
      }
    }

    // mines clean up
    if (match.map === ReplayTypes.MapType.HauntedMines) {
      for (let g in golems) {
        let golem = golems[g];

        if (golem) {
          let objEvent = {
            startLoop: golem.loop,
            startTime: golem.time,
            endLoop: match.loopLength,
          };
          objEvent.endTime = loopsToSeconds(
            objEvent.endLoop - match.loopGameStart
          );
          objEvent.duration = objEvent.endTime - objEvent.startTime;
          objEvent.team = golem.team;
          golems[g] = null;

          log.trace(
            '[TRACKER] Team ' +
              objEvent.team +
              ' golem lasted for ' +
              objEvent.duration +
              ' seconds'
          );

          match.objective[objEvent.team].push(objEvent);
        }
      }
    }
    // garden clean up
    else if (match.map === ReplayTypes.MapType.HauntedWoods) {
      for (let t in currentTerror) {
        let terror = currentTerror[t];

        if (terror.active) {
          let team = parseInt(t);
          let duration =
            match.loopLength -
            match.objective[team].events[
              match.objective[team].events.length - 1
            ].loop;
          match.objective[team].events[
            match.objective[team].events.length - 1
          ].loopDuration = duration;
          match.objective[team].events[
            match.objective[team].events.length - 1
          ].duration = loopsToSeconds(duration);
          match.objective[team].events[
            match.objective[team].events.length - 1
          ].player = terror.player;

          currentTerror[t].active = false;

          log.trace(
            '[TRACKER] Team ' +
              team +
              ' terror lasted for ' +
              loopsToSeconds(duration) +
              ' seconds'
          );
        }
      }
    } else if (match.map === ReplayTypes.MapType.DragonShire) {
      // turns out a dragon can spawn well after the game ends,
      // it isn't assigned to a team by the parser if this is the case, so skip it
      if (dragon && (dragon.team === 0 || dragon.team === 1)) {
        // log duration
        let lastIdx = match.objective[dragon.team].events.length - 1;
        match.objective[dragon.team].events[lastIdx].loopDuration =
          match.loopLength - match.objective[dragon.team].events[lastIdx].loop;
        match.objective[dragon.team].events[lastIdx].duration = loopsToSeconds(
          match.objective[dragon.team].events[lastIdx].loopDuration
        );
        match.objective[dragon.team].events[lastIdx].player = dragon.player;

        dragon = null;
      }
    } else if (match.map === ReplayTypes.MapType.Crypts) {
      if (currentSpiders.active === true) {
        let spider = currentSpiders.units[Object.keys(currentSpiders.units)[0]];
        match.objective[currentSpiders.team].events[
          currentSpiders.eventIdx
        ].duration = loopsToSeconds(match.loopLength - spider.loop);
        match.objective[currentSpiders.team].events[
          currentSpiders.eventIdx
        ].endLoop = match.loopLength;
        match.objective[currentSpiders.team].events[
          currentSpiders.eventIdx
        ].end = loopsToSeconds(match.loopLength - match.loopGameStart);
      }
    } else if (match.map === ReplayTypes.MapType.Volskaya) {
      if (currentProtector.active) {
        let duration = loopsToSeconds(match.loopLength - currentProtector.loop);
        match.objective[currentProtector.team].events[
          currentProtector.eventIdx
        ].duration = duration;
      }
    } else if (match.map === ReplayTypes.MapType['Warhead Junction']) {
      // nuke sorting
      for (let id in nukes) {
        let nuke = nukes[id];
        match.objective[nuke.team].events.push(nuke);
        match.objective[nuke.team].count += 1;

        // if success is true or undefined (never died, mark as success) mark it
        if (nuke.success === true || !('success' in nuke))
          match.objective[nuke.team].success += 1;
      }
    } else if (match.map === ReplayTypes.MapType.BattlefieldOfEternity) {
      if ('tag' in immortal) {
        let res = match.objective.results.length - 1;
        match.objective.results[res].immortalDuration = loopsToSeconds(
          match.loopLength - immortal.start
        );
      }
    } else if (match.map === ReplayTypes.MapType.AlteracPass) {
      for (let i of [0, 1]) {
        let units = match.objective[i].events;
        for (let j in units) {
          if (!('died' in units[j])) {
            units[j].died = loopsToSeconds(
              match.loopLength - match.loopGameStart
            );
          }
        }
      }
    }

    // hero life cleanup
    for (const pid in playerIDMap) {
      const player = players[playerIDMap[pid]];
      for (uid in player.units) {
        const currentLife =
          player.units[uid].lives[player.units[uid].lives.length - 1];
        if (!currentLife.died) {
          // won't record death time? didn't technically die
          currentLife.duration =
            loopsToSeconds(match.loopLength - match.loopGameStart) -
            currentLife.born;
        }
      }
    }

    log.debug('[TRACKER] Adding final XP breakdown');

    match.XPBreakdown.push(team0XPEnd);
    match.XPBreakdown.push(team1XPEnd);

    // get a few more bits of summary data from the players...
    match.teams = {
      0: { ids: [], names: [], heroes: [], tags: [] },
      1: { ids: [], names: [], heroes: [], tags: [] },
    };
    match.teams[0].takedowns = match.team0Takedowns;
    match.teams[1].takedowns = match.team1Takedowns;

    // final match stats pass
    for (let p in players) {
      players[p].gameStats.KDA =
        players[p].gameStats.Takedowns /
        Math.max(players[p].gameStats.Deaths, 1);
      players[p].gameStats.damageDonePerDeath =
        players[p].gameStats.HeroDamage /
        Math.max(1, players[p].gameStats.Deaths);
      players[p].gameStats.damageTakenPerDeath =
        players[p].gameStats.DamageTaken /
        Math.max(1, players[p].gameStats.Deaths);
      players[p].gameStats.healingDonePerDeath =
        (players[p].gameStats.Healing +
          players[p].gameStats.SelfHealing +
          players[p].gameStats.ProtectionGivenToAllies) /
        Math.max(1, players[p].gameStats.Deaths);
      players[p].gameStats.DPM =
        players[p].gameStats.HeroDamage / (match.length / 60);
      players[p].gameStats.HPM =
        (players[p].gameStats.Healing +
          players[p].gameStats.SelfHealing +
          players[p].gameStats.ProtectionGivenToAllies) /
        (match.length / 60);
      players[p].gameStats.XPM =
        players[p].gameStats.ExperienceContribution / (match.length / 60);

      if (players[p].team === ReplayTypes.TeamType.Blue) {
        players[p].gameStats.KillParticipation =
          players[p].gameStats.Takedowns / match.team0Takedowns;
        players[p].gameStats.length = match.length;
        match.teams[0].level = players[p].gameStats.Level;
        match.teams[0].heroes.push(players[p].hero);
        match.teams[0].names.push(players[p].name);
        match.teams[0].tags.push(players[p].tag);
        match.teams[0].ids.push(p);

        if (players[p].win) {
          match.winner = ReplayTypes.TeamType.Blue;
        }
      } else if (players[p].team === ReplayTypes.TeamType.Red) {
        players[p].gameStats.KillParticipation =
          players[p].gameStats.Takedowns / match.team1Takedowns;
        players[p].gameStats.length = match.length;
        match.teams[1].level = players[p].gameStats.Level;
        match.teams[1].heroes.push(players[p].hero);
        match.teams[1].names.push(players[p].name);
        match.teams[1].tags.push(players[p].tag);
        match.teams[1].ids.push(p);

        if (players[p].win) {
          match.winner = ReplayTypes.TeamType.Red;
        }
      }
    }

    // uh ok one more time
    for (let p in players) {
      players[p].with = match.teams[players[p].team];

      if (players[p].team === ReplayTypes.TeamType.Blue) {
        players[p].against = match.teams[ReplayTypes.TeamType.Red];
      } else if (players[p].team === ReplayTypes.TeamType.Red) {
        players[p].against = match.teams[ReplayTypes.TeamType.Blue];
      }
    }

    if (match.winner !== 0 && match.winner !== 1) {
      // match has no winner and is incomplete. reject
      return { status: ReplayStatus.Incomplete };
    }

    match.winningPlayers = match.teams[match.winner].ids;

    log.debug('[TRACKER] Event Analysis Complete');

    log.debug('[MESSAGES] Message Processing Start...');

    var messages = data.messageevents;
    match.messages = [];

    for (let i = 0; i < messages.length; i++) {
      let message = messages[i];

      let msg = {};
      msg.type = message._eventid;

      // don't really care about these
      if (msg.type === ReplayTypes.MessageType.LoadingProgress) continue;

      if (!(message._userid.m_userId in playerLobbyID)) continue;

      msg.player = playerLobbyID[message._userid.m_userId];
      msg.team = players[msg.player].team;
      msg.recipient = message.m_recipient;
      msg.loop = message._gameloop;
      msg.time = loopsToSeconds(msg.loop - match.loopGameStart);

      if (message._eventid === ReplayTypes.MessageType.Ping) {
        msg.point = { x: message.m_point.x, y: message.m_point.y };
      } else if (message._eventid === ReplayTypes.MessageType.Chat) {
        msg.text = message.m_string;
      } else if (message._eventid === ReplayTypes.MessageType.PlayerAnnounce) {
        msg.announcement = message.m_announcement;
      }

      match.messages.push(msg);
    }

    log.debug('[MESSAGES] Message Processing Complete');

    if ('gameevents' in data) {
      log.debug('[GAME] Taunt Detection Running...');

      // this is probably the worst use of cpu cycles i can think of but i'm gonna do it
      var gameLog = data.gameevents;
      var playerBSeq = {};
      for (let i = 0; i < gameLog.length; i++) {
        // the b action is likely of type 27 however i don't actually know how to interpret that data
        // working theory: eventid 27 abilLink 116 is the current b.
        // this actually varies per-build, so while i missed a few builds, it should work at the moment.
        let event = gameLog[i];
        if (event._eventid === 27) {
          if (
            (event.m_abil &&
              match.version.m_build < 61872 &&
              event.m_abil.m_abilLink === 200) ||
            (event.m_abil &&
              match.version.m_build >= 61872 &&
              match.version.m_build < 68740 &&
              event.m_abil.m_abilLink === 119) ||
            (event.m_abil &&
              match.version.m_build >= 68740 &&
              match.version.m_build < 70682 &&
              event.m_abil.m_abilLink === 116) ||
            (event.m_abil &&
              match.version.m_build >= 70682 &&
              match.version.m_build < 77525 &&
              event.m_abil.m_abilLink === 112) ||
            (event.m_abil &&
              match.version.m_build >= 77525 &&
              match.version.m_build < 79033 &&
              event.m_abil.m_abilLink === 114) ||
            (event.m_abil &&
              match.version.m_build >= 79033 &&
              event.m_abil.m_abilLink === 115)
          ) {
            // player ids are actually off by one here
            let playerID = event._userid.m_userId;
            let id = playerLobbyID[playerID];

            if (!(id in playerBSeq)) playerBSeq[id] = [];

            // create chains of b-actions. threshold is within 16 loops (1 second)
            if (playerBSeq[id].length === 0) playerBSeq[id].push([event]);
            else {
              const currentSeq = playerBSeq[id].length - 1;
              const currentStep = playerBSeq[id][currentSeq].length - 1;
              const currentEvent = playerBSeq[id][currentSeq][currentStep];

              // sequence tracks in what order inputs happened, in order to b step there's gotta be a
              // move command between the b presses, so if the sequence diff is 1, then it's not a bstep
              if (
                Math.abs(currentEvent._gameloop - event._gameloop) <=
                  BSTEP_FRAME_THRESHOLD &&
                Math.abs(currentEvent.m_sequence - event.m_sequence) > 1
              ) {
                playerBSeq[id][currentSeq].push(event);
              } else {
                playerBSeq[id].push([event]);
              }
            }
          }
          // taunts and dances
          else if (
            (event.m_abil &&
              match.version.m_build < 68740 &&
              event.m_abil.m_abilLink === 19) ||
            (event.m_abil &&
              match.version.m_build >= 68740 &&
              event.m_abil.m_abilLink === 22)
          ) {
            let playerID = event._userid.m_userId;
            let id = playerLobbyID[playerID];

            let eventObj = {};
            eventObj.loop = event._gameloop;
            eventObj.time = loopsToSeconds(
              event._gameloop - match.loopGameStart
            );
            eventObj.kills = 0;
            eventObj.deaths = 0;

            // taunt
            if (event.m_abil.m_abilCmdIndex === 4) {
              players[id].taunts.push(eventObj);
            }
            // dance
            else if (event.m_abil.m_abilCmdIndex === 3) {
              players[id].dances.push(eventObj);
            }
          }
        }
      }

      processTauntData(players, match.takedowns, playerBSeq);
    }

    log.debug('[GAME] Taunt Detection Complete');

    log.debug('[STATS] Collecting Team Stats...');

    collectTeamStats(match, players);
    computeLevelDiff(match);
    analyzeLevelAdv(match);
    analyzeUptime(match, players);

    // also compute some xp stats here for 41.0
    // passive xp rate
    match.teams[0].stats.passiveXPRate =
      team0XPEnd.breakdown.TrickleXP / match.length;
    match.teams[1].stats.passiveXPRate =
      team1XPEnd.breakdown.TrickleXP / match.length;

    // passive diff from normal
    // normal rate is 20 xp/s
    const passiveXP = 20;
    const baselinePassive = passiveXP * match.length;

    match.teams[0].stats.passiveXPDiff =
      team0XPEnd.breakdown.TrickleXP / baselinePassive;
    match.teams[1].stats.passiveXPDiff =
      team1XPEnd.breakdown.TrickleXP / baselinePassive;

    match.teams[0].stats.passiveXPGain =
      team0XPEnd.breakdown.TrickleXP - baselinePassive;
    match.teams[1].stats.passiveXPGain =
      team1XPEnd.breakdown.TrickleXP - baselinePassive;

    // store a few team stats in the player stat object
    // final team stats pass
    for (const p in players) {
      const teamStats = match.teams[players[p].team].stats;

      players[p].gameStats.passiveXPRate = teamStats.passiveXPRate;
      players[p].gameStats.passiveXPDiff = teamStats.passiveXPDiff;
      players[p].gameStats.passiveXPGain = teamStats.passiveXPGain;
      players[p].gameStats.aces = teamStats.aces;
      players[p].gameStats.wipes = teamStats.wipes;
      players[p].gameStats.timeWithHeroAdv = teamStats.timeWithHeroAdv;
      players[p].gameStats.pctWithHeroAdv = teamStats.pctWithHeroAdv;
      players[p].gameStats.levelAdvTime = teamStats.levelAdvTime;
      players[p].gameStats.levelAdvPct = teamStats.levelAdvPct;
    }

    log.debug('[STATS] Team stat collection complete');

    log.debug('[STATS] Setting Match Flags...');

    // did the first pick win the match
    if (match.picks) {
      match.firstPickWin = match.picks.first === match.winner;
    } else {
      // QM will show up as false here
      match.firstPickWin = false;
    }

    match.firstObjective = getFirstObjectiveTeam(match);
    match.firstObjectiveWin = match.winner === match.firstObjective;
    match.firstFort = getFirstFortTeam(match);
    match.firstKeep = getFirstKeepTeam(match);
    match.firstFortWin = match.winner === match.firstFort;
    match.firstKeepWin = match.winner === match.firstKeep;

    log.debug('[STATS] Match Flags set.');

    return { match, players, status: ReplayStatus.OK };
  } catch (err) {
    log.error({ error: err });
    return { status: ReplayStatus.Failure };
  }
}

function processScoreArray(data, match, players, playerIDMap) {
  log.debug('[SCORE DATA] Processing Start');

  // ok so custom games have empty arrays where observers sit
  // also the data isn't continuous, i believe the order is the same (as in data
  // for internal game user 1 comes before game user 2) and the empty arrays just need to
  // be removed

  // iterate through each object...
  for (var i = 0; i < data.length; i++) {
    var name = data[i].m_name;
    var valArray = data[i].m_values;
    let realIndex = 0;

    if (!name.startsWith('EndOfMatchAward')) {
      for (let j = 0; j < valArray.length; j++) {
        if (valArray[j].length > 0) {
          let playerID = realIndex + 1;
          players[playerIDMap[playerID]].gameStats[name] =
            valArray[j][0].m_value;
          realIndex += 1;
        }
      }
    } else {
      for (let j = 0; j < valArray.length; j++) {
        if (valArray[j].length > 0) {
          let playerID = realIndex + 1;
          if (valArray[j][0].m_value === 1) {
            players[playerIDMap[playerID]].gameStats.awards.push(name);
          }
          realIndex += 1;
        }
      }
    }
  }

  log.debug('[SCORE DATA] Processing Complete');
}

function processTauntData(players, takedowns, playerBSeq) {
  // process the bseq arrays
  for (let id in playerBSeq) {
    let playerSeqs = playerBSeq[id];
    for (let i = 0; i < playerSeqs.length; i++) {
      if (playerSeqs[i].length > 2) {
        // reformat the data and place in the player data
        let bStep = {};
        bStep.start = playerSeqs[i][0]._gameloop;
        bStep.stop = playerSeqs[i][playerSeqs[i].length - 1]._gameloop;
        bStep.duration = bStep.stop - bStep.start;
        bStep.kills = 0;
        bStep.deaths = 0;

        let min = bStep.start - 80;
        let max = bStep.stop + 80;

        // scan the takedowns array to see if anything interesting happened
        // range is +/- 5 seconds (80 loops)
        for (let j = 0; j < takedowns.length; j++) {
          let td = takedowns[j];
          let time = td.loop;

          if (min <= time && time <= max) {
            // check involved players
            if (td.victim.player === id) bStep.deaths += 1;

            if (
              td.killers.find(function (elem) {
                return elem.player === id;
              })
            )
              bStep.kills += 1;
          }
        }

        players[id].bsteps.push(bStep);
      }
    }
  }

  for (let id in players) {
    let player = players[id];

    // taunts
    for (let i = 0; i < player.taunts.length; i++) {
      let tauntTime = player.taunts[i].loop;

      for (let j = 0; j < takedowns.length; j++) {
        let td = takedowns[j];
        let time = td.loop;

        if (Math.abs(tauntTime - time) <= 80) {
          // check involved players
          if (td.victim.player === id) player.taunts[i].deaths += 1;

          if (
            td.killers.find(function (elem) {
              return elem.player === id;
            })
          )
            player.taunts[i].kills += 1;
        }
      }
    }

    // voice lines
    for (let i = 0; i < player.voiceLines.length; i++) {
      let tauntTime = player.voiceLines[i].loop;

      for (let j = 0; j < takedowns.length; j++) {
        let td = takedowns[j];
        let time = td.loop;

        if (Math.abs(tauntTime - time) <= 80) {
          // check involved players
          if (td.victim.player === id) player.voiceLines[i].deaths += 1;

          if (
            td.killers.find(function (elem) {
              return elem.player === id;
            })
          )
            player.voiceLines[i].kills += 1;
        }
      }
    }

    // sprays
    for (let i = 0; i < player.sprays.length; i++) {
      let tauntTime = player.sprays[i].loop;

      for (let j = 0; j < takedowns.length; j++) {
        let td = takedowns[j];
        let time = td.loop;

        if (Math.abs(tauntTime - time) <= 80) {
          // check involved players
          if (td.victim.player === id) player.sprays[i].deaths += 1;

          if (
            td.killers.find(function (elem) {
              return elem.player === id;
            })
          )
            player.sprays[i].kills += 1;
        }
      }

      // dances
      for (let i = 0; i < player.dances.length; i++) {
        let tauntTime = player.dances[i].loop;

        for (let j = 0; j < takedowns.length; j++) {
          let td = takedowns[j];
          let time = td.loop;

          if (Math.abs(tauntTime - time) <= 80) {
            // check involved players
            if (td.victim.player === id) player.dances[i].deaths += 1;

            if (
              td.killers.find(function (elem) {
                return elem.player === id;
              })
            )
              player.dances[i].kills += 1;
          }
        }
      }
    }
  }
}

function braxisWaveStrength(units, build) {
  // determines the strength of the wave based on
  // this is basically just a max of all the possible percentages indicated by the units
  var types = {};

  for (let t in ReplayTypes.BraxisUnitType) {
    types[t] = 0;
  }

  for (let u in units) {
    types[units[u].type] += 1;
  }

  // percentage counts
  var score = 0;
  if (build < 66488) {
    score =
      0.05 * (types[ReplayTypes.BraxisUnitType.ZergZergling] - 6) +
      types[ReplayTypes.BraxisUnitType.ZergBaneling] * 0.05;
    score = Math.max(
      score,
      types[ReplayTypes.BraxisUnitType.ZergHydralisk] * 0.14
    );
    score = Math.max(
      score,
      types[ReplayTypes.BraxisUnitType.ZergGuardian] * 0.3
    );
  } else if (build < 75589) {
    // skip ultralisks they're unreliable
    score = 0.1 * types[ReplayTypes.BraxisUnitType.ZergBaneling];
    score = Math.max(
      score,
      0.25 * (types[ReplayTypes.BraxisUnitType.ZergHydralisk] - 2)
    );
    score = Math.max(
      score,
      0.35 * (types[ReplayTypes.BraxisUnitType.ZergGuardian] - 1)
    );
    // 2.47.0
  } else {
    score = 0.1 * types[ReplayTypes.BraxisUnitType.ZergBaneling];
    score = Math.max(
      score,
      0.24 * (types[ReplayTypes.BraxisUnitType.ZergHydralisk])
    );
    score = Math.max(
      score,
      0.30 * (types[ReplayTypes.BraxisUnitType.ZergGuardian])
    );
    // Since each team starts with 1 active Ultralisk and 2 inactive ones,
    // I'm not sure if we should subtract 1 or 3 here,
    // because I don't know if the inactive ones are being counted
    // for the starting group of Zergs or not.
    // Due to this, I'll choose 3 because it won't break the code if wrong,
    // but only cause Ultralisks to be ignored for the calculations.
    // Only change it to 1 if you are 100% sure it will work!
    score = Math.max(
      score,
      0.45 * (types[ReplayTypes.BraxisUnitType.ZergUltralisk] - 3)
    );
  }

  return score;
}

function collectTeamStats(match, players) {
  // merc capture count
  for (let t in match.teams) {
    match.teams[t].stats = {};

    // object keys are strings so bleh convert back
    let team = parseInt(t);

    // merc captures
    match.teams[t].stats.mercCaptures = 0;
    for (let m in match.mercs.captures) {
      if (match.mercs.captures[m].team === team) {
        match.teams[t].stats.mercCaptures += 1;
      }
    }

    // merc uptime
    match.teams[t].stats.mercUptime = 0;
    match.teams[t].stats.mercUptimePercent = 0;
    // basically combine the intervals, then sum the durations
    let intervals = [];
    for (let m in match.mercs.units) {
      let unit = match.mercs.units[m];
      if (unit.team === team) {
        let interval = [unit.time];
        if (!('duration' in unit)) {
          interval.push(match.length);
        } else {
          interval.push(unit.time + unit.duration);
        }
        intervals.push(interval);
      }
    }

    // combine intervals
    intervals = combineIntervals(intervals);

    // sum
    for (let i in intervals) {
      match.teams[t].stats.mercUptime += intervals[i][1] - intervals[i][0];
    }

    match.teams[t].stats.mercUptimePercent =
      match.teams[t].stats.mercUptime / match.length;

    // time to first fort and keep
    let otherTeam = team === 0 ? 1 : 0;
    let structures = {};
    for (let s in match.structures) {
      let structure = match.structures[s];

      if (!(structure.name in structures)) {
        structures[structure.name] = {
          lost: 0,
          destroyed: 0,
          first: match.length,
        };
      }
      if ('destroyed' in structure) {
        if (structure.team === team) {
          structures[structure.name].lost += 1;
        } else if (structure.team === otherTeam) {
          structures[structure.name].destroyed += 1;
          structures[structure.name].first = Math.min(
            structures[structure.name].first,
            structure.destroyed
          );
        }
      }
    }
    match.teams[t].stats.structures = structures;

    // team kda
    let totalTD = match.teams[t].takedowns;
    let totalDeaths = match.teams[otherTeam].takedowns;
    match.teams[t].stats.KDA = totalTD / Math.max(totalDeaths, 1);

    // people per kill
    let ppk = 0;
    for (let i in match.takedowns) {
      let td = match.takedowns[i];

      if (match.teams[otherTeam].ids.indexOf(td.victim.player) !== -1) {
        ppk += td.killers.length;
      }
    }
    match.teams[t].stats.PPK = ppk / Math.max(totalTD, 1);

    if ('10' in match.levelTimes[t]) {
      match.teams[t].stats.timeTo10 = match.levelTimes[t]['10'].time;
    }

    if ('20' in match.levelTimes[t]) {
      match.teams[t].stats.timeTo20 = match.levelTimes[t]['20'].time;
    }

    // stats
    // only certain stats really make sense for teams
    let totals = {
      DamageTaken: 0,
      CreepDamage: 0,
      Healing: 0,
      HeroDamage: 0,
      MinionDamage: 0,
      SelfHealing: 0,
      SiegeDamage: 0,
      ProtectionGivenToAllies: 0,
      TeamfightDamageTaken: 0,
      TeamfightHealingDone: 0,
      TeamfightHeroDamage: 0,
      TimeCCdEnemyHeroes: 0,
      TimeRootingEnemyHeroes: 0,
      TimeSpentDead: 0,
      TimeStunningEnemyHeroes: 0,
      TimeSilencingEnemyHeroes: 0,
    };
    for (let p in players) {
      let player = players[p];
      if (player.team === team) {
        for (let s in totals) {
          totals[s] += player.gameStats[s];
        }
      }
    }
    totals.avgTimeSpentDead = totals.TimeSpentDead / 5;
    totals.timeDeadPct = totals.avgTimeSpentDead / match.length;
    match.teams[t].stats.totals = totals;
  }
}

function analyzeUptime(match, players) {
  log.debug('[STATS] Performing hero lifespan analysis');

  // compute per player uptime intervals (due to TLV, have to combine intervals)
  for (id in players) {
    analyzePlayerHeroUptime(players[id]);
  }

  team0Uptime = analyzeTeamPlayerUptime(0, players);
  team1Uptime = analyzeTeamPlayerUptime(1, players);

  match.teams[0].stats.uptime = team0Uptime.teamLifespan;
  match.teams[0].stats.uptimeHistogram = team0Uptime.heroCount;
  match.teams[0].stats.wipes = team0Uptime.wipes;
  match.teams[0].stats.avgHeroesAlive = team0Uptime.avgHeroesAlive;
  match.teams[0].stats.aces = team1Uptime.wipes;

  match.teams[1].stats.uptime = team1Uptime.teamLifespan;
  match.teams[1].stats.uptimeHistogram = team1Uptime.heroCount;
  match.teams[1].stats.wipes = team1Uptime.wipes;
  match.teams[1].stats.avgHeroesAlive = team1Uptime.avgHeroesAlive;
  match.teams[1].stats.aces = team0Uptime.wipes;

  // time w hero advantage
  match.teams[0].stats.timeWithHeroAdv = timeWithHeroAdv(
    match.teams[0].stats.uptime,
    match.teams[1].stats.uptime,
    match.length
  );
  match.teams[1].stats.timeWithHeroAdv = timeWithHeroAdv(
    match.teams[1].stats.uptime,
    match.teams[0].stats.uptime,
    match.length
  );
  match.teams[0].stats.pctWithHeroAdv =
    match.teams[0].stats.timeWithHeroAdv / match.length;
  match.teams[1].stats.pctWithHeroAdv =
    match.teams[1].stats.timeWithHeroAdv / match.length;

  log.debug('[STATS] Hero lifespan analysis complete');
}

function analyzePlayerHeroUptime(player) {
  // combine life intervals, and that's basically it.
  // time spent dead is the stat here, but i need a bit more detail
  const intervals = [];
  for (let unitId in player.units) {
    const unit = player.units[unitId];
    for (const life of unit.lives) {
      if (!life.died) {
        intervals.push([life.born, player.length]);
      } else {
        intervals.push([life.born, life.died]);
      }
    }
  }

  player.lifespan = combineIntervals(intervals);
}

function analyzeTeamPlayerUptime(team, players) {
  // team is an int
  const events = [];
  let matchLength = 0;
  for (const id in players) {
    if (players[id].team !== team) continue;

    // savin for later
    matchLength = players[id].length;

    // check lifespans, add events
    for (const life of players[id].lifespan) {
      // skip preinit
      if (life[0] > 0) {
        events.push({ time: life[0], str: 1 });
      }

      // if it's the last one, don't add a death
      if (life[1] !== players[id].length) {
        events.push({ time: life[1], str: -1 });
      }
    }
  }

  // sort events by time
  events.sort(function (a, b) {
    if (a.time > b.time) return 1;
    else if (a.time < b.time) return -1;
    return 0;
  });

  // starting at strength 5, modify strength every time an event occurs
  const teamLifespan = [{ time: 0, heroes: 5 }];
  let currentHeroes = 5;
  for (const event of events) {
    currentHeroes += event.str;

    teamLifespan.push({
      time: event.time,
      heroes: currentHeroes,
    });
  }

  // analyze intervals
  const heroCount = {};
  let wipes = 0;
  let avgHeroesAlive = 0;

  for (let i = 0; i < teamLifespan.length; i++) {
    let nextTime;
    if (i + 1 >= teamLifespan.length) {
      // pull match length from any player
      nextTime = matchLength;
    } else {
      nextTime = teamLifespan[i + 1].time;
    }

    const dur = nextTime - teamLifespan[i].time;
    const str = teamLifespan[i].heroes;

    if (!(str in heroCount)) heroCount[str] = 0;

    heroCount[str] += dur;

    if (str === 0) wipes += 1;

    avgHeroesAlive += str * dur;
  }

  avgHeroesAlive = avgHeroesAlive / matchLength;

  return {
    teamLifespan,
    heroCount,
    wipes,
    avgHeroesAlive,
  };
}

function timeWithHeroAdv(base, compare, matchLength) {
  // for every pt, compare team strength
  const xs = [];
  for (const x of base) xs.push(x.time);

  for (const x of compare) xs.push(x.time);

  xs.sort(function (a, b) {
    if (a > b) {
      return 1;
    } else if (a < b) {
      return -1;
    }
    return 0;
  });

  // compare at all time points
  let advTime = 0;
  for (let i = 0; i < xs.length; i++) {
    const baseStr = getStrAtTime(base, xs[i]);
    const compareStr = getStrAtTime(compare, xs[i]);
    if (baseStr > compareStr) {
      // interval length
      if (i + 1 >= xs.length) {
        advTime += matchLength - xs[i];
      } else {
        advTime += xs[i + 1] - xs[i];
      }
    }
  }

  return advTime;
}

function getStrAtTime(data, time) {
  let str = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i];

    if (d.time <= time) str = d.heroes;
  }

  return str;
}

function computeLevelDiff(match) {
  // format level timings
  const adv = [];
  for (let t in match.levelTimes) {
    for (let lv in match.levelTimes[t]) {
      let level = match.levelTimes[t][lv];
      level.team = t;
      adv.push(level);

      if (level.level === 1) continue;
    }

    let keys = Object.keys(match.levelTimes[t]);
    let last = keys[keys.length - 1];
    adv.push({
      team: t,
      time: match.length,
      level: match.levelTimes[t][last].level,
    });
  }

  // level advantage
  // calculate the intervals and the level diff at each interval
  adv.sort(function (a, b) {
    if (a.time === b.time) return 0;
    if (a.time < b.time) return -1;

    return 1;
  });

  let start = 0;
  let currentLevelDiff = 0;
  let blueLevel = 1;
  let redLevel = 1;
  const levelAdvTimeline = [];
  for (let i = 0; i < adv.length; i++) {
    let event = adv[i];

    if (event.team === '0') {
      blueLevel = event.level;
    } else {
      redLevel = event.level;
    }

    // blue = positive, red = negative
    let newLevelDiff = blueLevel - redLevel;

    if (newLevelDiff !== currentLevelDiff) {
      // end the previous group
      let item = {
        start,
        end: event.time,
        levelDiff: currentLevelDiff,
      };
      item.length = item.end - item.start;
      levelAdvTimeline.push(item);

      start = event.time;
      currentLevelDiff = newLevelDiff;
    }
  }

  // final levels
  let lastLevelDiff = blueLevel - redLevel;
  let lastItem = {
    start,
    end: match.length,
    levelDiff: lastLevelDiff,
  };
  lastItem.length = lastItem.end - lastItem.start;
  levelAdvTimeline.push(lastItem);
  match.levelAdvTimeline = levelAdvTimeline;
}

function analyzeLevelAdv(match) {
  let blueAdvTime = 0;
  let redAdvTime = 0;
  let blueMaxAdv = 0;
  let redMaxAdv = 0;
  let blueLvlAvg = 0;
  let redLvlAvg = 0;

  for (const lv of match.levelAdvTimeline) {
    if (lv.levelDiff > 0) {
      blueAdvTime += lv.length;
      blueLvlAvg += lv.length * Math.abs(lv.levelDiff);

      if (Math.abs(lv.levelDiff) > blueMaxAdv) {
        blueMaxAdv = Math.abs(lv.levelDiff);
      }
    } else if (lv.levelDiff < 0) {
      redAdvTime += lv.length;
      redLvlAvg += lv.length * Math.abs(lv.levelDiff);

      if (Math.abs(lv.levelDiff) > redMaxAdv) {
        redMaxAdv = Math.abs(lv.levelDiff);
      }
    }
  }

  match.teams[0].stats.levelAdvTime = blueAdvTime;
  match.teams[1].stats.levelAdvTime = redAdvTime;
  match.teams[0].stats.maxLevelAdv = blueMaxAdv;
  match.teams[1].stats.maxLevelAdv = redMaxAdv;
  match.teams[0].stats.avgLevelAdv = blueLvlAvg / match.length;
  match.teams[1].stats.avgLevelAdv = redLvlAvg / match.length;
  match.teams[0].stats.levelAdvPct = blueAdvTime / match.length;
  match.teams[1].stats.levelAdvPct = redAdvTime / match.length;
}

// lifted from http://blog.sodhanalibrary.com/2015/06/merge-intervals-using-javascript.html
function combineIntervals(intervals) {
  if (intervals.length <= 1) return intervals;

  // sort
  intervals.sort(function (a, b) {
    if (a[0] > b[0]) {
      return 1;
    } else if (a[0] < b[0]) {
      return -1;
    }
    return 0;
  });

  let result = [];
  let prev = intervals[0];
  for (let i = 1; i < intervals.length; i++) {
    let c = intervals[i];

    if (prev[1] >= c[0]) {
      // merge
      let merged = [prev[0], Math.max(prev[1], c[1])];
      prev = merged;
    } else {
      result.push(prev);
      prev = c;
    }
  }

  result.push(prev);
  return result;
}

function getFirstObjectiveTeam(match) {
  try {
    if (
      match.map === ReplayTypes.MapType.DragonShire ||
      match.map === ReplayTypes.MapType.Crypts ||
      match.map === ReplayTypes.MapType.Volskaya ||
      match.map === ReplayTypes.MapType.AlteracPass ||
      match.map === ReplayTypes.MapType.BlackheartsBay
    ) {
      if (
        match.objective[0].events.length === 0 &&
        match.objective[1].events.length === 0
      )
        return null;
      // shutouts
      if (
        match.objective[0].events.length === 0 &&
        match.objective[1].events.length > 0
      )
        return 1;
      if (
        match.objective[1].events.length === 0 &&
        match.objective[0].events.length > 0
      )
        return 0;
      if (
        match.objective[0].events[0].time === match.objective[1].events[0].time
      )
        return null;

      return match.objective[0].events[0].time <
        match.objective[1].events[0].time
        ? 0
        : 1;
    } else if (match.map === ReplayTypes.MapType.HauntedWoods) {
      // check id of first terror
      // shutouts
      if (
        match.objective[0].units.length === 0 &&
        match.objective[1].units.length > 0
      )
        return 1;
      if (
        match.objective[1].units.length === 0 &&
        match.objective[0].units.length > 0
      )
        return 0;
      if (match.objective[0].units[0].loop === match.objective[1].units[0].loop)
        return null;

      return match.objective[0].units[0].loop < match.objective[1].units[0].loop
        ? 0
        : 1;
    } else if (match.map === ReplayTypes.MapType.ControlPoints) {
      // add all shots to an array, sort by time, count
      let shots = [].concat(
        match.objective[0].events,
        match.objective[1].events
      );
      shots.sort(function (a, b) {
        return a.loop - b.loop;
      });

      // count first 90
      let blueCt = 0;
      let redCt = 0;
      for (let i = 0; i < 90; i++) {
        // just in case
        if (i >= shots.length) break;

        if (shots[i].team === ReplayTypes.TeamType.Blue) blueCt += 1;
        else if (shots[i].team === ReplayTypes.TeamType.Red) redCt += 1;
      }

      if (blueCt === redCt) return null;

      return blueCt > redCt
        ? ReplayTypes.TeamType.Blue
        : ReplayTypes.TeamType.Red;
    } else if (match.map === ReplayTypes.MapType.TowersOfDoom) {
      // add everything to an array, check who wins first 2/3
      let altars = [].concat(
        match.objective[0].events,
        match.objective[1].events
      );
      altars.sort(function (a, b) {
        return a.loop - b.loop;
      });

      let blueCt = 0;
      let redCt = 0;

      // it is technically possible (but highly unlikely) that no altars are captured
      for (let i = 0; i < 3; i++) {
        if (i >= altars.length) break;

        if (altars[i].team === ReplayTypes.TeamType.Blue) blueCt += 1;
        else if (altars[i].team === ReplayTypes.TeamType.Red) redCt += 1;
      }

      if (blueCt === redCt) return null;

      return blueCt > redCt
        ? ReplayTypes.TeamType.Blue
        : ReplayTypes.TeamType.Red;
    } else if (match.map === ReplayTypes.MapType.CursedHollow) {
      // first to 3
      let tributes = [].concat(
        match.objective[0].events,
        match.objective[1].events
      );
      tributes.sort(function (a, b) {
        return a.loop - b.loop;
      });

      let blueCt = 0;
      let redCt = 0;
      for (let i = 0; i < tributes.length; i++) {
        if (tributes[i].team === ReplayTypes.TeamType.Blue) blueCt += 1;
        else if (tributes[i].team === ReplayTypes.TeamType.Red) redCt += 1;

        if (blueCt >= 3) return ReplayTypes.TeamType.Blue;

        if (redCt >= 3) return ReplayTypes.TeamType.Red;
      }

      // if no one got a curse, return null
      return null;
    } else if (match.map === ReplayTypes.MapType['Warhead Junction']) {
      let nukes = [].concat(
        match.objective[0].events,
        match.objective[1].events
      );
      nukes.sort(function (a, b) {
        return a.loop - b.loop;
      });

      // best out of 4 successful
      let blueCt = 0;
      let redCt = 0;
      let total = 0;
      for (let i = 0; i < nukes.length; i++) {
        if (nukes[i].success) {
          if (nukes[i].team === ReplayTypes.TeamType.Blue) blueCt += 1;
          else if (nukes[i].team === ReplayTypes.TeamType.Red) redCt += 1;

          total += 1;
        }

        if (total >= 4) break;
      }

      if (blueCt === redCt) return null;

      return blueCt > redCt
        ? ReplayTypes.TeamType.Blue
        : ReplayTypes.TeamType.Red;
    } else if (match.map === ReplayTypes.MapType.BattlefieldOfEternity) {
      if (match.objective.results.length > 0) {
        return match.objective.results[0].winner;
      }

      return null;
    } else if (match.map === ReplayTypes.MapType.Shrines) {
      if (match.objective.shrines.length > 0) {
        return match.objective.shrines[0].team;
      }

      return null;
    } else if (match.map === ReplayTypes.MapType.BraxisHoldout) {
      if (match.objective.waves.length > 0) {
        return match.objective.waves[0].startScore[0] >
          match.objective.waves[0].startScore[1]
          ? 0
          : 1;
      }

      return null;
    }
    // haunted mines: unsure how to detect first objective

    return null;
  } catch (err) {
    log.error({ error: err });
    return null;
  }
}

function getFirstFortTeam(match) {
  let t0Fort = match.teams[0].stats.structures.Fort;
  let t1Fort = match.teams[1].stats.structures.Fort;

  if (t0Fort.first > t1Fort.first) return 1;
  else if (t0Fort.first < t1Fort.first) return 0;

  // same time
  return -1;
}

function getFirstKeepTeam(match) {
  let t0Keep = match.teams[0].stats.structures.Keep;
  let t1Keep = match.teams[1].stats.structures.Keep;

  // towers of doom has keeps but they upgrade from forts,
  // so if a team ends before the keeps upgrade, it doesn't count
  if (!t0Keep || !t1Keep) return -2;

  if (t0Keep.first > t1Keep.first) return 1;
  else if (t0Keep.first < t1Keep.first) return 0;

  // same time
  return -1;
}

// general parsing utilities, not db specific
function winFileTimeToDate(filetime) {
  return new Date(filetime / 10000 - 11644473600000);
}

function loopsToSeconds(loops) {
  // apparently hots does 16 updates per second
  return loops / 16;
}

exports.parse = parse;
exports.loopsToSeconds = loopsToSeconds;
exports.ReplayDataType = ReplayDataType;
exports.CommonReplayData = CommonReplayData;
exports.AllReplayData = AllReplayData;
exports.processReplay = processReplay;
exports.ReplayStatus = ReplayStatus;
exports.StatusString = StatusString;
exports.getHeader = getHeader;
exports.getBattletags = getBattletags;
exports.getFirstObjectiveTeam = getFirstObjectiveTeam;
exports.winFileTimeToDate = winFileTimeToDate;
exports.getFirstFortTeam = getFirstFortTeam;
exports.getFirstKeepTeam = getFirstKeepTeam;
exports.VERSION = PARSER_VERSION;
exports.MAX_SUPPORTED_BUILD = MAX_SUPPORTED_BUILD;

log.info(
  { versions: { parser: PARSER_VERSION } },
  'loaded parser.js v' + require('./package.json').version
);
