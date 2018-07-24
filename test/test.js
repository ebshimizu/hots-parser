/*jshint esversion: 6 */

const fs = require("fs");
const expect = require('chai').expect;
const parser = require('../parser.js');

const HeroesTalents = require('heroes-talents');
const Heroes = new HeroesTalents.HeroesTalents('node_modules/heroes-talents/' + 'assets/heroes-talents', 'node_modules/heroes-talents/' + 'assets/data');


const readJson = (path, cb) => {
  fs.readFile(require.resolve(path), (err, data) => {
    if (err)
      cb(err)
    else
      cb(null, JSON.parse(data))
  })
}
const towers = parser.processReplay('test/replays/towers-of-doom.StormReplay', Heroes);

describe('parser.js', function () {
    it('parser version 6', function () {
        let result = parser.VERSION;
        expect(result).to.be.equal(6);
    });

    it('json deep equal', function () {
		readJson(__dirname + '/towers-of-doom.json', (err, settings) => {
			expect(towers).to.be.deep.equal(settings)
			done(err)
	    });
    });

});
