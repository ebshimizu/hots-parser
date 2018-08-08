# hots-parser

A node-based Heroes of the Storm parser.

## Setup

While we get this set up to be a node package, your best bet to use the parser is to
clone it and install the required packages manually:

```
git clone
npm install heroprotocol xregexp
```

Eventually this package will be in npm, but it isn't ready just quite yet.

## Usage

```
const Parser = require('./parser.js')
```

### processReplay()

`Parser.processReplay(file, options = {})`

Main replay processing function.

**Arguments**

`file` - String containing the path to the replay file.

`options` - Optional object that can contain the following:

- `getBMData` : bool, default `true`. Set to false to skip parsing all
taunts, b-step, spray, and dance events. These options use the `gamedata` archive, which adds
significant processing time as the parser loads and inspects all game events.
- `useAttributeName` : bool, default `false`. Set to true to leave hero names unresolved
and use the internal attribute code instead.
Hero names are stored in the `attr.js` file, and will lag behind patches by approximately one day.
If you'd like to not worry about new heroes causing problems, you will want to set this to true.

**Returns**

JSON object containing `result`, `match`, and `players` keys.

`result` integer status code indicating success or failure. You want to see a `1` here.
See `Parser.ReplayStatus` for possible values of this field.

`match` contains information about the parsed match. It gathers team-specific data, and can be linked
back to players via the player's ToonHandles.

`players` contains 10 objects. Each object is keyed by the player's ToonHandle (unique identifier).
These objects contain player-specific statistics.

The best way to see the results of these files is to run the parser and inspect the output yourself.

**Notes**

This parser does not allow AI games to be parsed and will throw an error if this occurs.

### ReplayStatus

`Parser.ReplayStatus`

**Values**

* `OK = 1`
* `Unsupported = 0`
* `Duplicate = -1` - This is a holdover from when the parser was part of Stats of the Storm
* `Failure = -2` - If you get this exception and it's not about a missing filepath, please report it. This indicates a general internal exception that should probably be fixed.
* `UnsupportedMap = -3` - Brawls are included in unsupported maps.
* `ComputerPlayerFound = -4` - AI games will not parse.
* `Incomplete = -5` - Partial replay detected. If the parser does not see a core destroyed it will be unable to find a winner and this status will be returned.
* `TooOld = -6` - Related to Incomplete. Usually returned if a winner is unable to be determined from some very old replays.

**Notes**

Values from this enum can be resolved into strings by passing it into `Parser.StatusString[]` (which is an object)

### parse()

`Parser.parse(filename, requestedData[], opts)`

Extract specific replay data. Data is returned unprocessed.

**Arguments**

`filename` - the path to the replay file

`requestedData` - Array containing keys specifying which data to get. Available values are in `Parser.ReplayDataType`.
You can also use shortcuts `Parser.CommonReplayData` (all data except game events) and `Parser.AllReplayData`
as arguments.

`options` - object containing the following possible values:

* `saveToFile` : string, doesn't exist by default. If this key is present, the replay data will also be
written to the specified file.

**Returns**

Object containing the specified replay data. Object keys are values in `Parser.ReplayDataType`.

### ReplayDataType

`Parser.ReplayDataType`

Values in this enum correspond with flags given to the reference Blizzard/heroprotocol implementation.

**Values**

* `game = "gameevents"`
* `message = "messageevents"`
* `tracker = "trackerevents`
* `attribute = "attributeevents"`
* `header = "header"`
* `details = "details"`
* `init = "initdata"`
* `stats = "stats"`

### getHeader()

`Parser.getHeader(file)`

Returns basic information about the match.

**Arguments**

`file` - path to the replay file

**Returns**

Object containing basic match data. Includes match version, date, players info (including ToonHandles),
map, and game mode.
