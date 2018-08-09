/*jshint esversion: 6 */

const fs = require("fs");
const expect = require('chai').expect;
const parser = require('../parser.js');

const readJSON = (path, cb) => {
    fs.readFile(require.resolve(path), (err, data) => {
        if (err) {
            cb(err);
        } else {
            cb(null, JSON.parse(data))
        }
    });
}


describe('parser.js', function () {
    it('load parser version 6', function () {
        let result = parser.VERSION;
        expect(result).to.be.equal(6);
    });
    it('load towers-of-doom.json', function() {
        this.knowngood = JSON.parse(fs.readFileSync(__dirname + '/json/towers-of-doom.json'));
        expect(this.knowngood).to.include({"status": 1});
    });
    it('parse towers-of-doom.StormReplay', function () {
        let parsed = parser.processReplay('test/replays/towers-of-doom.StormReplay');
        this.towers = JSON.parse(JSON.stringify(parsed)); // convert nodejs object to JSON.
        expect(this.towers).to.include({"status": 1});
    });
    it('validate parser against json', function () {
         expect(this.towers).to.deep.equal(this.knowngood);
    });

});
