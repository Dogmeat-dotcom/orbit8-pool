// rules.js — UK Pub Rules (Reds/Yellows) with:
// - Two visits after foul
// - First visit is free shot
// - Ball-in-hand anywhere
// - Black cannot be potted on free shot

class EightBallRules {

    constructor() {
        this.reset();
    }

    reset() {
        this.tableOpen = true;       // colours not chosen
        this.playerColours = { p1: null, p2: null };
        this.turn = "p1";
        this.visits = 1;             // 1 or 2
        this.freeShot = false;       // true = can hit any ball first
        this.gameOver = false;
        this.winner = null;

        this.lastShot = {
            fouls: [],
            pocketed: [],
            cueBallPotted: false,
            hitOwnBallFirst: null,
            hitBall: false,
        };
    }

    /***************************************************
     * RESET SHOT CONTEXT
     ***************************************************/
    startShot() {
        this.lastShot = {
            fouls: [],
            pocketed: [],
            cueBallPotted: false,
            hitOwnBallFirst: null,
            hitBall: false,
        };
    }

    /***************************************************
     * RECORD FIRST HIT
     ***************************************************/
    registerFirstHit(ballNum, colour) {
        if (this.lastShot.hitBall) return; // ignore after first

        this.lastShot.hitBall = true;

        // pool.js will pass us: "red", "yellow", "black", "cue"
        if (colour === "cue") return;

        this.lastShot.hitOwnBallFirst = colour;
    }

    /***************************************************
     * RECORD BALL POT
     ***************************************************/
    registerPocket(ballNum, colour) {
        this.lastShot.pocketed.push({ ballNum, colour });
        if (colour === "cue") this.lastShot.cueBallPotted = true;
    }

    /***************************************************
     * DETERMINE PLAYER’S BALL GROUP
     ***************************************************/
    assignColoursIfNeeded() {

        if (!this.tableOpen) return;

        const pots = this.lastShot.pocketed
            .filter(p => p.colour !== "black" && p.colour !== "cue");

        if (pots.length === 0) return;

        const first = pots[0].colour;

        if (first !== "red" && first !== "yellow") return;

        // Assign the table
        this.tableOpen = false;
        this.playerColours[this.turn] = first;
        this.playerColours[this.other(this.turn)] =
            (first === "red" ? "yellow" : "red");
    }

    /***************************************************
     * CHECK FOULS IN THIS SHOT
     ***************************************************/
    evaluateFouls() {

        const fouls = this.lastShot.fouls;

        /* 1. Cue ball potted */
        if (this.lastShot.cueBallPotted) {
            fouls.push("Cue ball potted");
        }

        /* 2. No ball hit */
        if (!this.lastShot.hitBall) {
            fouls.push("No ball hit");
        }

        /* 3. Wrong first hit after colours chosen */
        if (!this.tableOpen && !this.freeShot) {
            const ownColour = this.playerColours[this.turn];
            if (this.lastShot.hitOwnBallFirst !== ownColour &&
                this.lastShot.hitOwnBallFirst !== "black") {
                fouls.push("Hit wrong ball first");
            }
        }

        /* 4. Black ball hit first illegally */
        if (!this.tableOpen && !this.freeShot) {
            const ownColour = this.playerColours[this.turn];
            if (this.lastShot.hitOwnBallFirst === "black") {
                const remaining = this.countRemaining(ownColour);
                if (remaining > 0) {
                    fouls.push("Hit black first illegally");
                }
            }
        }

        /* 5. Potting opponent ball */
        if (!this.tableOpen) {
            const own = this.playerColours[this.turn];
            const opp = this.playerColours[this.other(this.turn)];

            const oppPotted = this.lastShot.pocketed
                .some(p => p.colour === opp);

            if (oppPotted && !this.freeShot) {
                fouls.push("Potted opponent ball");
            }
        }

        /* 6. Potting black early */
        const blackPot = this.lastShot.pocketed
            .some(p => p.colour === "black");

        if (blackPot) {

            // free-shot black pot ALWAYS loses (your chosen rule)
            if (this.freeShot) {
                fouls.push("Black potted illegally on free shot");
                this.gameOver = true;
                this.winner = this.other(this.turn);
                return fouls;
            }

            // not on black yet?
            const own = this.playerColours[this.turn];
            if (!this.tableOpen && this.countRemaining(own) > 0) {
                fouls.push("Potted black early");
                this.gameOver = true;
                this.winner = this.other(this.turn);
                return fouls;
            }
        }

        return fouls;
    }

    /***************************************************
     * COUNT REMAINING BALLS OF A COLOUR
     ***************************************************/
    countRemaining(colour) {
        // server.js must give us the current balls state
        return this.ballsState
            .filter(b => b.colour === colour && !b.inPocket).length;
    }

    /***************************************************
     * APPLY END-OF-SHOT LOGIC
     ***************************************************/
    finalizeShot(ballsState) {

        this.ballsState = ballsState.map(b => ({
            number: b.number,
            colour: this.getColour(b.number),
            inPocket: b.inPocket
        }));

        this.assignColoursIfNeeded();

        const fouls = this.evaluateFouls();

        if (this.gameOver) return this.output();

        if (fouls.length > 0) {
            // FOUL → 2 visits + free shot
            this.turn = this.other(this.turn);
            this.visits = 2;
            this.freeShot = true;
            return this.output();
        }

        // LEGAL SHOT HANDLING

        const pottedOwn = this.lastShot.pocketed
            .filter(p => p.colour === this.playerColours[this.turn]).length;

        const pottedOpp = this.lastShot.pocketed
            .filter(p => p.colour === this.playerColours[this.other(this.turn)]).length;

        const blackPot = this.lastShot.pocketed
            .some(p => p.colour === "black");

        if (blackPot) {
            // legal black win
            this.gameOver = true;
            this.winner = this.turn;
            return this.output();
        }

        if (this.tableOpen) {
            // Still open table → same player continues if any pot
            if (this.lastShot.pocketed.length > 0) {
                this.visits = 1;
                this.freeShot = false;
            } else {
                this.endVisit();
            }
            return this.output();
        }

        // Colour-assigned rules
        if (pottedOwn > 0) {
            // Continue turn
            this.visits = 1;
            this.freeShot = false;
            return this.output();
        }

        if (pottedOpp > 0) {
            // Opponent ball potted (not foul because table is open or free-ball)
            // Shot ends but NO foul
            this.endVisit();
            return this.output();
        }

        // No pot
        this.endVisit();
        return this.output();
    }

    endVisit() {
        if (this.visits === 2) {
            this.visits = 1;
            this.freeShot = false;
        } else {
            this.turn = this.other(this.turn);
            this.visits = 1;
            this.freeShot = false;
        }
    }

    /***************************************************/
    other(p) { return p === "p1" ? "p2" : "p1"; }

    getColour(num) {
        if (num === 0) return "cue";
        if (num === 8) return "black";
        if (num >= 1 && num <= 7) return "red";
        if (num >= 9 && num <= 15) return "yellow";
        return "unknown";
    }

    /***************************************************
     * OUTPUT STRUCT
     ***************************************************/
    output() {
        return {
            tableOpen: this.tableOpen,
            turn: this.turn,
            visits: this.visits,
            freeShot: this.freeShot,
            colours: this.playerColours,
            fouls: this.lastShot.fouls,
            pocketed: this.lastShot.pocketed,
            gameOver: this.gameOver,
            winner: this.winner
        };
    }
}

module.exports = EightBallRules;
