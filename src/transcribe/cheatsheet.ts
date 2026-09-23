// The jianpu-ly syntax reference, for the filterable cheat-sheet pane.
//
// Transcribed from the jianpu-ly README (Silas S. Brown, Apache-2.0):
// https://github.com/ssb22/jianpu-ly — every entry the upstream docs list, in
// the upstream order, plus a `support` flag saying what THIS app can engrave.
// abcjs is a five-line-staff renderer, so a few of jianpu-ly's idioms (raw
// LilyPond, arpeggios) have nowhere to go; they're marked so the sheet tells
// the truth rather than quietly dropping them.
//
// The erhu ornaments and hanzi-lyric lines are deliberately NOT listed — this
// sheet is a working reference, not a mirror of upstream. H: still parses if
// you paste a chart that uses it; it just isn't advertised here.

export type Support =
  | 'yes'      // engraved as written
  | 'partial'  // engraved, but not exactly as the original would
  | 'no';      // recognised and skipped, with a warning

export type Entry = {
  group: string;
  syntax: string;
  what: string;
  support: Support;
  note?: string;      // why it's partial / what we do instead
};

export const CHEATSHEET: Entry[] = [
  // ── pitch ──────────────────────────────────────────────────────────
  { group: 'Pitch', syntax: `1 2 3 4 5 6 7 1'`, what: 'Scale going up', support: 'yes' },
  { group: 'Pitch', syntax: `1 #1 2 b2 1`, what: 'Accidentals', support: 'yes' },
  { group: 'Pitch', syntax: `f3`, what: 'Flat — an alias for b3', support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Pitch', syntax: `1,, 1, 1 1' 1''`, what: 'Octaves', support: 'yes' },
  { group: 'Pitch', syntax: `1-- 1- 1 1+ 1++`, what: 'Octaves, the same thing with signs — + is up, - is down', support: 'yes', note: `this app only — mixes freely with ' and , ; the older > and < spelling is gone` },
  { group: 'Pitch', syntax: `1=`, what: 'No octave change — says out loud that this note sits at the base octave', support: 'yes', note: 'this app only — it moves nothing; it keeps a line of notes lined up and readable' },
  { group: 'Pitch', syntax: `8 9`, what: `Shortcuts for 1' and 2'`, support: 'yes' },
  { group: 'Pitch', syntax: `x`, what: 'Percussion beat', support: 'partial', note: 'drawn as a notehead on the middle line' },
  { group: 'Pitch', syntax: `, '`, what: `On their own: move the base octave. Everything after , is an octave below the register that was running, after ' an octave above. A note's own mark then reads relative to that base`, support: 'yes', note: `this app only — the mark MOVES the register rather than setting it, so a , after a , is a second octave down; ; is what puts it back to the middle` },
  { group: 'Pitch', syntax: `,, ''`, what: 'Two octaves out from wherever you are — the same move the mark makes on a note, one more per character (,,, is three)', support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Pitch', syntax: `=`, what: 'Back to the original register AND the original beat, so a bare = puts the whole reading frame back. It is what a line opens with to say where it is on its own, since everything else moves from where it finds you', support: 'yes', note: 'this app only — a bare = on its own, not attached to a note' },
  { group: 'Pitch', syntax: `;`, what: `Just the register, leaving the beat alone — back to the middle`, support: 'yes', note: `this app only — : is the same thing for the beat, and = is both at once` },
  { group: 'Pitch', syntax: `;, ;''`, what: `A reset counts FIRST, so a mark after one is absolute: ;, is an octave below the middle however far the music had already wandered, ;'' two above it`, support: 'yes', note: 'this app only — the same goes for the beat (:\\ is a quaver whatever was running) and for the bare =, which puts both back before the marks move off it' },
  { group: 'Pitch', syntax: `c d e f g a b`, what: 'Notes by name instead of by number — c is middle C. The key decides what number each one comes out as, so c in 1=Bb is a 2', support: 'yes', note: `this app only — a letter note carries no digit, which is what tells "c" (middle C) apart from "c1" (a crotchet on degree 1)` },
  { group: 'Pitch', syntax: `f# bb c' c,,`, what: `The same marks a number takes: # and b for accidentals, ' and , for octaves`, support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Pitch', syntax: `c\\ c/ c. cq`, what: `And the same duration marks — but after the letter, never before: c\\ is a quaver, c/ a minim, c. a dotted crotchet, cq a quaver again`, support: 'yes', note: `this app only — b, f, c, d and e are note names, so a mark in front would be read as the note; only ' and , can lead ('d is d')` },
  { group: 'Pitch', syntax: `' c ; c`, what: `Letter notes sit in the base register like every other note: c is middle C, but after a standalone ' it is the C above, and a ; puts it back`, support: 'yes', note: 'this app only — the letter says which note, the register says which octave you are writing in' },
  { group: 'Pitch', syntax: `0`, what: 'Rest', support: 'yes' },

  // ── rhythm ─────────────────────────────────────────────────────────
  { group: 'Rhythm', syntax: `s1 q1 1`, what: 'Semiquaver, quaver, crotchet (16/8/4th notes)', support: 'yes' },
  { group: 'Rhythm', syntax: `e1`, what: 'Eighth note — an alias for q1, if you think in American names', support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Rhythm', syntax: `1\\\\ 1\\ 1`, what: 'Alternate way to input semiquaver, quaver, crotchet', support: 'yes', note: 'any \\ must go after the pitch, not before' },
  { group: 'Rhythm', syntax: `KeepLength s1 1 1 1 c1`, what: 'Sticky durations (4 semiquavers then crotchet)', support: 'yes' },
  { group: 'Rhythm', syntax: `s1. q1. 1.`, what: 'Dotted versions of the above (50% longer)', support: 'yes' },
  { group: 'Rhythm', syntax: `1\\\\. 1\\.`, what: 'Alternate dotted versions', support: 'yes' },
  { group: 'Rhythm', syntax: `1.. q1.. 1/..`, what: 'Double dotted (75% longer): a second dot adds half of what the first one added, and it engraves as a real double-dotted note rather than a tie', support: 'yes', note: 'a third dot works the same way, if the value still lands on a tick' },
  { group: 'Rhythm', syntax: `d1 h1`, what: 'Demisemiquaver, hemidemisemiquaver (32/64th notes)', support: 'yes' },
  { group: 'Rhythm', syntax: `1 -`, what: 'Minims (half notes) use dashes', support: 'yes' },
  { group: 'Rhythm', syntax: `1 - -`, what: 'Dotted minim', support: 'yes' },
  { group: 'Rhythm', syntax: `1 - - -`, what: 'Semibreve (whole note)', support: 'yes' },
  { group: 'Rhythm', syntax: `1 . 1 . . 1 . . .`, what: `Alternate Indonesian-style minim, dotted minim and semibreve (dot is treated as dash)`, support: 'yes' },
  { group: 'Rhythm', syntax: `1/ 1// 1/.`, what: 'Double the value: minim, semibreve, dotted minim', support: 'yes', note: 'this app only — the original uses / for tremolo, which abcjs cannot draw' },
  { group: 'Rhythm', syntax: `\\ 1 2 3 4`, what: `On its own: halve or double the beat. In crotchets, after \\ a bare number is a quaver, after \\\\ a semiquaver, after / a minim, after // a semibreve — and a hold dash adds one of those`, support: 'yes', note: `this app only — the same mark a note carries, standing alone; it MOVES the beat rather than setting it, so a \\ after a \\ halves it again, and : puts it back` },
  { group: 'Rhythm', syntax: `\\ 1 1\\ 1/`, what: `A note's own \\ and / then count off THAT beat — in quavers, 1\\ is a semiquaver and 1/ a crotchet`, support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Rhythm', syntax: `: 1`, what: 'Back to the original beat, leaving the register alone', support: 'yes', note: 'this app only — ; is the same thing for the register, and = is both at once' },
  { group: 'Rhythm', syntax: `\\, 1 2`, what: `Both at once: in quavers, an octave down, from here on. Either order — ,\\ reads the same — and a bare = puts both back`, support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Rhythm', syntax: `\\. 1`, what: 'A dotted beat: after this a bare number is a dotted quaver', support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Rhythm', syntax: `\\[ 1 2 3 4 ]`, what: 'Beat group: inside the brackets the beat is a quaver, so a bare number is one of them', support: 'yes', note: `this app only — it says the passage is IN quavers instead of repeating q on every note` },
  { group: 'Rhythm', syntax: `\\\\[ 1 2 1/ ]`, what: `Any note value opens one: \\\\[ is a semiquaver beat, //[ a semibreve, and s[ q[ c[ name one outright. Inside, \\ / and . halve, double and dot against it, so 1/ here is a quaver`, support: 'yes', note: 'this app only — a group inside a group counts off its parent, and the ] puts back whatever was running before' },
  { group: 'Rhythm', syntax: `\\[ 1 - - ]`, what: 'A hold dash inside a group adds one of ITS beats — here a dotted crotchet, not a dotted minim', support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Rhythm', syntax: `1 1 1 R`, what: 'A rest filling whatever is left of the bar', support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Rhythm', syntax: `R 1 |`, what: 'It fills around the notes on both sides — here 3 beats’ rest, then beat 4', support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Rhythm', syntax: `1 1 |`, what: 'A bar that doesn’t add up is padded with rests, as if an R sat at the end of it', support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Rhythm', syntax: `3[ q1 q1 q1 ]`, what: 'Tuplets', support: 'yes' },
  { group: 'Rhythm', syntax: `3\\[ 1 2 3 ]`, what: 'Triplet of quavers: a tuplet opener may name the beat too, and then every bare number inside is one of them', support: 'yes', note: 'this app only — 3\\[ is 3[ and \\[ in one bracket, so 3\\\\[ 1 2 3 ] is a semiquaver triplet and 3q[ names the value outright' },

  // ── the score ──────────────────────────────────────────────────────
  { group: 'Score', syntax: `4/4`, what: 'Time signature', support: 'yes' },
  { group: 'Score', syntax: `4/4,8`, what: `Time signature with anacrusis (pickup) — number after comma is pickup's value`, support: 'yes' },
  { group: 'Score', syntax: `CONCERT=Bb`, what: `What the page is written FOR, on a line of its own at the top: C (the default) or Bb. It moves nothing on the page — a Bb part is drawn exactly as a trumpet or a tenor reads it — it says what the writing SOUNDS, so playback (and a MIDI keyboard played over it) comes out a tone lower and meets the concert-pitch recording`, support: 'yes', note: 'this app only. It also answers to the horn: CONCERT=tenor, CONCERT=trumpet. Transposing the MUSIC is a different act, and a written one — that is the selection menu, which rewrites the notes' },
  { group: 'Score', syntax: `1=Bb`, what: 'Key signature (major)', support: 'yes' },
  { group: 'Score', syntax: `6=F#`, what: 'Key signature (minor)', support: 'yes' },
  { group: 'Score', syntax: `K=Eb`, what: 'Printed key signature, set independently of where do sits', support: 'yes', note: 'this app only — pitches are unchanged, only which accidentals are drawn' },
  { group: 'Score', syntax: `1 1 1 1 | 1=Eb 1 1 1 1`, what: 'Modulate: a 1= after the music has started moves the key from that point on, and draws a new key signature there', support: 'yes', note: 'this app only — the same goes for K= and 6=; a K= already in force keeps controlling what is printed, so the modulation comes out in accidentals instead' },
  { group: 'Score', syntax: `1 1 | 1=Eb[ 1 2 3 5 ] 1 1`, what: 'Modulate for a passage only: the numbers read against Eb inside the brackets, and the ] restores whatever key was running before it — the bridge, without having to remember the way out', support: 'yes', note: 'this app only — K=Eb[ … ] scopes the printed signature the same way; it’s the same bracket a tuplet and a beat group use, and the three nest' },
  { group: 'Score', syntax: `select a passage`, what: 'Respell it in another key centre: a menu floats over the selection with the centres this song already uses, plus a box for any other. The numbers move, the pitches do not', support: 'yes', note: 'this app only — it plants a 1= at the head of the passage and restores the old one after it' },
  { group: 'Score', syntax: `select a passage`, what: 'Transpose it: the second line of the same menu takes semitones — −1, +1, or any number typed in. The pitches MOVE: every 1= and K= is rewritten, every chord symbol with them, every note written by name (c, f#, bb) with them, and the register marks it takes to keep the octave right go in. Select the whole text and it\u2019s the whole chart', support: 'yes', note: 'this app only — the key it lands in is chosen the way a copyist would: up a semitone from C is Db, not C#. Numbers need none of this, which is the point of writing in them: they are already relative to the 1=' },
  { group: 'Score', syntax: `4=85`, what: 'Tempo', support: 'yes' },
  { group: 'Score', syntax: `title=the title`, what: 'Lilypond title (on a line of its own)', support: 'yes' },
  { group: 'Score', syntax: `subtitle= composer= poet= arranger= copyright= opus=`, what: 'Other Lilypond headers', support: 'partial', note: 'title / subtitle / composer / poet / arranger are drawn' },
  { group: 'Score', syntax: `instrument=Flute`, what: 'Instrument of current part (on a line of its own)', support: 'yes' },
  { group: 'Score', syntax: `NextPart`, what: 'Multiple parts', support: 'partial', note: 'each part is engraved as its own score, not stacked in one system' },
  { group: 'Score', syntax: `NextScore`, what: 'Multiple movements', support: 'yes' },
  { group: 'Score', syntax: `SeparateTimesig 1=C 4/4`, what: 'Old-style time signature', support: 'no', note: 'layout-only; ignored' },
  { group: 'Score', syntax: `angka`, what: `Indonesian 'not angka' style`, support: 'no', note: 'layout-only; ignored' },
  { group: 'Score', syntax: `WithStaff`, what: 'Add a Western staff doubling the tune', support: 'partial', note: 'this app always draws a western staff' },

  // ── layout ─────────────────────────────────────────────────────────
  { group: 'Layout', syntax: `OnePage`, what: 'Prohibit page breaks until end of this movement', support: 'no', note: 'layout-only; ignored' },
  { group: 'Layout', syntax: `NoBarNums`, what: 'Suppress bar numbers', support: 'no', note: 'layout-only; ignored' },
  { group: 'Layout', syntax: `NoIndent`, what: 'Suppress first-line indent', support: 'no', note: 'layout-only; ignored' },
  { group: 'Layout', syntax: `RaggedLast`, what: 'Ragged last line', support: 'no', note: 'layout-only; ignored' },
  { group: 'Layout', syntax: `1 1 1 1 BR`, what: 'End the staff line here', support: 'yes', note: 'this app only — one BR switches the whole score to hand-placed breaks; a BR at the very end justifies the last line' },
  { group: 'Layout', syntax: `1 1 1 1 BR BR`, what: 'Every BR past the first opens up more space before the next line', support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Layout', syntax: `1 1 1 1 BR3`, what: 'The same run written as a count — BR3 is three BRs in a row, so two extra gaps of space', support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Layout', syntax: `BR= BR2; BR:`, what: `A reset character on the end does what it does standing alone: BR= starts the next line back on the original beat and in the middle register, BR; just the register, BR: just the beat`, support: 'yes', note: 'this app only — the head of a fresh line is usually where you want to say it, and this saves a second token' },
  { group: 'Layout', syntax: `%  a comment`, what: 'Ignored', support: 'yes', note: '⌘/ (ctrl+/) comments the selected lines out, or brings them back' },
  { group: 'Layout', syntax: `%%%`, what: 'Everything from here to the end of the page is ignored — the line you draw under the piece, with the sketches swept below it', support: 'yes', note: 'this app only — there is no closing it; the page itself ends it. A % on its own still runs only to the end of its line' },

  // ── words ──────────────────────────────────────────────────────────
  { group: 'Words', syntax: `L: here are the syl- la- bles`, what: 'Lyrics (all on one line, or newline after the : and double newline to end)', support: 'yes' },
  { group: 'Words', syntax: `L: 1. Here is verse one`, what: 'Lyrics (verse 1)', support: 'yes' },
  { group: 'Words', syntax: `L: 2. Here is verse two`, what: 'Lyrics (verse 2)', support: 'yes' },
  { group: 'Words', syntax: `^"above note"  _"below note"`, what: 'Text', support: 'yes' },

  // ── chords ─────────────────────────────────────────────────────────
  { group: 'Chords', syntax: `chords=c2. g:7 c`, what: 'Guitar chords (on own line, or newline after the = and double newline to end)', support: 'partial', note: 'common LilyPond chordmode qualities only' },
  { group: 'Chords', syntax: `C"G G7/B | C7 C#dim | G7 | |"`, what: 'Chords bar by bar, on a line above the music. Chords inside a bar are spread across it — one goes on beat 1, two on 1 and 3, three on 1, 3 and 4 — and an empty bar carries nothing', support: 'yes', note: 'this app only — not in the original syntax' },
  { group: 'Chords', syntax: `C"""\n|: G G7/B | C7 C#dim :|\nA7 | | D7 | |\n"""`, what: 'The whole form, pasted in once, between triple quotes. A newline ends a bar the way a | does, so the chart can be laid out the way it reads — and it LOOPS, playing round and round until another chord chart takes over or the music runs out', support: 'yes', note: `this app only. Finish on a final barline (|.) to have the form play once instead of looping. Write the bars either way round — fenced (| Am | D7 |) or each bar followed by its barline (Am | D7 |) — but pick one for the whole chart: the first line decides whether a | at the head of a later line opens that line or ends an empty bar in front of it` },
  { group: 'Chords', syntax: `|: G7 | C7 :|`, what: 'A repeated section inside a chord chart: the bars between |: and :| are played twice. :|x3 plays them three times, and :|: closes one section and opens the next', support: 'yes', note: 'this app only — the chords are written once and heard twice, so transposing them still edits one set of characters' },
  { group: 'Chords', syntax: `| G7 | C7 |`, what: 'A barline at the head of a line opens it rather than closing an empty bar in front of it, so either house style comes out the same', support: 'yes', note: 'this app only — || divides sections and is read as a plain barline' },
  { group: 'Chords', syntax: `X: x x. x\\ x\\`, what: 'The comping rhythm, on a rhythm staff of its own under the music: one line, X noteheads, stems down. x is a hit, 0 a rest — and every duration mark the music uses works here too', support: 'yes', note: 'this app only — it takes no time away from the line you are transcribing, so a stab can land where the melody is holding a note' },
  { group: 'Chords', syntax: `X: 0 x x - | x 0 3[ x x x ]`, what: 'Bar for bar against the music, like the chord line: | starts the next bar, a short bar is padded with rests, and a bar the stabs say nothing about comes out as a bar’s rest', support: 'yes', note: 'this app only — the music decides where the bars are; brackets, ties and R all work, and a bracket opened on the line has to close on it' },
  { group: 'Chords', syntax: `B: 1, 5, | 6, 5, -`, what: 'The bass line, on a bass-clef staff of its own under the music. Written in the same language as everything else \u2014 the same degrees, the same duration marks, the same brackets \u2014 and it keeps its OWN register, beat and brackets, so nothing it does leaks into the line above', support: 'yes', note: 'this app only. A bare 1 is the tonic where a bass plays it, an octave below the melody\u2019s, and the register marks read from there — a , on one B: line is still in force on the next one, so a bass part that lives low says so once. Bar for bar against the music like the X: line: the music decides where the bars are, a bar the bass says nothing about comes out as a bar\u2019s rest, and the key \u2014 modulations included \u2014 is the music\u2019s. It plays on the mix\u2019s bass voice' },
  { group: 'Chords', syntax: `T: 3 5 | 4 6`, what: 'A part on a treble-clef staff of its own under the music — an inner voice, a horn line, a written-out chord. Same language, same rules as the B: line, and it reads in the melody\u2019s own register rather than an octave down', support: 'yes', note: 'this app only. It plays on the mix\u2019s chords voice, which is where a part that isn\u2019t the tune belongs' },
  { group: 'Chords', syntax: `T2: 1 3` + '\n' + `B2: 1, -`, what: 'As many staves as the music needs: T:, T2:, T3: … and B:, B2:, B3: …, each its own part with its own register and beat. The tune is always the top staff; under it come the stabs, then the T staves in number order, then the B staves \u2014 whatever order you wrote them in', support: 'yes', note: 'this app only. T: and T1: are the same staff, as are B: and B1:. Write a staff\u2019s lines wherever they belong in the text: every line marked T2: goes to the same staff, bar for bar with the music like all the rest' },
  { group: 'Chords', syntax: `C"II-7 V7/II- | bIII-7 SubV7/II | IMaj7 |"`, what: 'Chords written as their function, Berklee style: an upper-case numeral with the quality after it. Each is read into the letter chord it names in the key in force where it sits, and that is what plays. After a slash, another numeral is the chord it leads to (V7/II- is the dominant of II-, and they chain: V7/V/V), a number is the bass as a degree (I/3), a letter the bass as a note (I/E); Sub in front is the tritone substitute. A slash with spaces round it still joins (V7 / II). Square brackets share one target across a run, barlines and all: [II-7 | V7] / VI- is the II-V of VI- (in B♭: A-7 D7), drawn as one bracketed group with the target said once', support: 'yes', note: 'this app only. With ii V on, the page shows the analysis exactly as you wrote it; off, it shows the letter chords. Numerals and letter chords mix freely in one chart. A lower-case numeral reads as minor too, and o is diminished (VIIo7)' },
  { group: 'Chords', syntax: `mix`, what: 'The three voices a performance is made of — the tune, the C" chord symbols comped underneath it (with the T: staves), and the B: staves — each with its own instrument and its own volume, remembered per song', support: 'yes', note: 'this app only. A volume moved while it plays lands on the note already sounding, which is the whole point of it' },
  { group: 'Chords', syntax: `frets=guitar`, what: 'Fret diagrams (on own line)', support: 'no' },
  { group: 'Chords', syntax: `ChordsRoman`, what: 'Change guitar chords into Roman numerals', support: 'no' },
  { group: 'Chords', syntax: `,135' 1 1b3 1`, what: 'Simple chords', support: 'yes' },
  { group: 'Chords', syntax: `arpUp 135 arpDown 531 arp 135`, what: 'Arpeggiated chords', support: 'no', note: 'the chord is drawn, the arpeggio sign is not' },

  // ── structure ──────────────────────────────────────────────────────
  { group: 'Structure', syntax: `1 1 Fine 1 1 1 1 1 1 DC`, what: 'Da capo', support: 'partial', note: 'drawn as text above the staff' },
  { group: 'Structure', syntax: `1 1 Segno 1 1 ToCoda 1 1 DS 1 1`, what: 'Dal segno', support: 'partial', note: 'drawn as text above the staff' },
  { group: 'Structure', syntax: `R{ 1 1 1 } A{ 2 | 3 }`, what: 'Repeat (with alternate endings)', support: 'yes' },
  { group: 'Structure', syntax: `R4{ 1 2 }`, what: 'Short repeats (percent)', support: 'partial', note: 'drawn as an ordinary repeat' },
  { group: 'Structure', syntax: `R*8`, what: 'Multibar rest', support: 'yes' },
  { group: 'Structure', syntax: `letterA letterB letter3 letterAA`, what: 'Rehearsal marks', support: 'yes' },
  { group: 'Structure', syntax: `M1 M2 M3`, what: `A place to come back to: mark 1 is the recording's 1st bookmark, so alt+1 takes the song there and the cursor here at the same time. Write it anywhere the parser reads — in the music, inside a C" chart, on a B: line`, support: 'yes', note: `this app only. No time passes — it is a spot in the writing — but it IS drawn: M1 goes over the note it lands on, wherever you wrote it (one inside a chart lands on the bar of the form it stands in, one on a B: line over the note of the tune above it). The bookmarks are counted by where they fall in the song, so adding or dropping one on the strip renumbers the M's to match, and dropping a bookmark takes its mark out of the text` },
  { group: 'Structure', syntax: `\\bar "||"   \\bar "|."`, what: 'Barlines (no LP: needed)', support: 'yes' },

  // ── articulation ───────────────────────────────────────────────────
  { group: 'Articulation', syntax: `1 ~ 1`, what: `Ties (like Lilypond's, if you don't want dashes)`, support: 'yes' },
  { group: 'Articulation', syntax: `1 ( 2 )`, what: `Slurs (like Lilypond's)`, support: 'yes' },
  { group: 'Articulation', syntax: `\\p \\mp \\f`, what: 'Dynamics (applies to previous note)', support: 'yes' },
  { group: 'Articulation', syntax: `\\fermata \\> \\! \\( \\)`, what: `Other 1-word Lilypond \\ commands`, support: 'partial', note: `the common ones map to abcjs decorations; the rest are skipped` },
  { group: 'Articulation', syntax: `g[ 4 5 ] 1`, what: 'Grace notes, leaning on the note after the ]', support: 'yes', note: 'ordinary notes inside a bracket — letters too: g[ e f e ]' },
  { group: 'Articulation', syntax: `g/[ 7, ] 1`, what: 'Crushed grace note (the slash through the stem)', support: 'yes' },
  { group: 'Articulation', syntax: `g[ s4 s5 ] 1`, what: 'Grace notes with a written value', support: 'yes', note: 'inside the bracket the beat is the quaver, which is what a grace note is unless you say otherwise' },
  { group: 'Articulation', syntax: `g[ 135 ] 1`, what: 'Grace chord', support: 'partial', note: 'ABC has no chord inside a grace group — drawn one after another, sounded together' },
  { group: 'Articulation', syntax: `1/// - 1///5 -`, what: 'Tremolo', support: 'no', note: '/ is reused here to double a note value' },
  { group: 'Articulation', syntax: `1 [( 2 3 )] 4`, what: 'Instrumental breaks in vocal music', support: 'partial', note: 'drawn as a slur' },

  // ── escape hatches ─────────────────────────────────────────────────
  { group: 'Raw LilyPond', syntax: `Harm: (music) :Harm`, what: 'Harmonic symbols above main notes', support: 'no' },
  { group: 'Raw LilyPond', syntax: `RepeatAccidentals #5 #2 NormalAccidentals`, what: 'Repeat same-bar accidentals in awkward passages', support: 'no' },
  { group: 'Raw LilyPond', syntax: `LP: (block of code) :LP`, what: 'Other Lilypond code (each delimiter at start of its line)', support: 'no', note: 'skipped — abcjs cannot run LilyPond' },
  { group: 'Raw LilyPond', syntax: `LPH: (definitions) :LPH`, what: 'Lilypond header additions', support: 'no' },
  { group: 'Raw LilyPond', syntax: `PartMidi`, what: 'Split MIDI files per part', support: 'no', note: 'no MIDI here' },
];

// Match a query against everything visible in a row, so "octave", "'", and
// "1''" all find the octaves line.
export function filterCheatsheet(q: string): Entry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return CHEATSHEET;
  const terms = needle.split(/\s+/);
  return CHEATSHEET.filter(e => {
    const hay = `${e.group} ${e.syntax} ${e.what} ${e.note ?? ''}`.toLowerCase();
    return terms.every(t => hay.includes(t));
  });
}

export const SUPPORT_LABEL: Record<Support, string> = {
  yes: 'engraved',
  partial: 'approximated',
  no: 'skipped',
};
