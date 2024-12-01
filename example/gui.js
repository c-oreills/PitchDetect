/*
The MIT License (MIT)

Copyright (c) 2014 Chris Wilson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

/*
Notes (ha!) on terminology:
- "note" refers to a musical note in a specific octave (e.g. C4)
- "octave" refers to the note's octave (e.g. the 4 of C4)
- "pitch class" refers to the note's position in the chromatic scale (e.g. C of C4)
*/

window.AudioContext = window.AudioContext || window.webkitAudioContext;

// From https://coolors.co/palettes/popular/contrast
const COLOURS = {
  blue: "#264653",
  green: "#2a9d8f",
  yellow: "#e9c46a",
  orange: "#f4a261",
  red: "#e76f51",
};

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 400;
const NOTE_HEIGHT = 15;
const LEFT_MARGIN = 32;
const INNER_CANVAS_WIDTH = CANVAS_WIDTH - LEFT_MARGIN;

const PITCH_CLASSES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];
const OCTAVES_SHOWN = 2;
const TOTAL_NOTES_SHOWN = PITCH_CLASSES.length * OCTAVES_SHOWN;

const SAMPLE_RATE_MS = 10;
// Occasionally the detector will drop a lot of samples
// (e.g. when performance is reduced due to low battery power)
// Make this configurable.
const GAPPINESS = 3;

// Radiate from middle C. Keys are note names, values are MIDI numbers.
const EXERCISE_NOTE_ORDER_MAJOR = new Map([
  ["C4", 60],
  ["D4", 62],
  ["B3", 59],
  ["E4", 64],
  ["A3", 57],
  ["F4", 65],
  ["G3", 55],
  ["G4", 67],
  ["F3", 53],
  ["A4", 69],
  ["E3", 52],
  ["B4", 71],
  ["D3", 50],
  ["C3", 48],
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

$(function () {
  // Global Variables
  var audioContext;
  var osc = null;
  var options = { start: true };
  var needsReset = true;
  var pitchDetector = null;
  var theBuffer = null;

  // Form Input Elements
  var inputs = {
    input: $("#input"),
    notes: $("#notes"),
    output: $("#output"),
    length: $("#length"),
    minRms: $("#minrms"),
    normalize: $("#normalize"),
    detection: $("#detection"),
    minCorrelationIncrease: $("#strength"),
    minCorrelation: $("#correlation"),
    range: $("#range"),
    min: $("#min"),
    max: $("#max"),
    draw: $("#draw"),
    stopAfterDetection: $("#stopAfterDetection"),
  };

  var data = JSON.parse(localStorage.getItem("pitch-detector-settings")) || {};
  for (var x in data) {
    inputs[x].val(data[x]);
  }

  // GUI Elements
  var gui = {
    detector: $("#detector"),
    pitch: $("#pitch"),
    note: $("#note"),
    detuneBox: $("#detune"),
    detune: $("#detune_amt"),
    exerciseNote: $("#exerciseNote"),
    exerciseHeader: $("#exerciseHeader"),
  };

  const buttons = {
    startExerciseMajorPrompted: $("#startExerciseMajorPrompted"),
    startExerciseMajorUnprompted: $("#startExerciseMajorUnprompted"),
  };

  // Canvas Element
  canvasEl = $("#waveform").get(0);
  var canvas = canvasEl.getContext("2d");
  window.savePic = function () {
    window.open(canvasEl.toDataURL("image/png"));
  };

  // Show/Hide Stuff on Form Change
  inputs.input.change(function (e) {
    needsReset = true;
    var val = inputs.input.val();
    if (val === "mic") {
      $("#notes").removeClass("invisible");
    } else {
      $("#notes").addClass("invisible");
    }
  });

  inputs.output.change(function (e) {
    needsReset = true;
  });

  inputs.length.change(function (e) {
    needsReset = true;
  });

  inputs.range.change(function (e) {
    var val = inputs.range.val();
    if (val !== "none") {
      $(".range").removeClass("hidden");
    } else {
      $(".range").addClass("hidden");
    }
  });

  inputs.detection.change(function (e) {
    var val = inputs.detection.val();
    $(".strength").addClass("hidden");
    $(".correlation").addClass("hidden");
    if (val === "strength") {
      $(".strength").removeClass("hidden");
    } else if (val === "correlation") {
      $(".correlation").removeClass("hidden");
    }
  });

  // Drag & Drop audio files
  var detectorElem = gui.detector.get(0);
  detectorElem.ondragenter = function () {
    this.classList.add("droptarget");
    return false;
  };
  detectorElem.ondragleave = function () {
    this.classList.remove("droptarget");
    return false;
  };
  detectorElem.ondrop = function (e) {
    this.classList.remove("droptarget");
    e.preventDefault();
    theBuffer = null;

    var reader = new FileReader();
    reader.onload = function (event) {
      audioContext.decodeAudioData(
        event.target.result,
        function (buffer) {
          theBuffer = buffer;
        },
        function () {
          alert("error loading!");
        }
      );
    };
    reader.onerror = function (event) {
      alert("Error: " + reader.error);
    };
    reader.readAsArrayBuffer(e.dataTransfer.files[0]);
    return false;
  };

  // Get example audio file
  var request = new XMLHttpRequest();
  request.open("GET", "./whistling3.ogg", true);
  request.responseType = "arraybuffer";
  request.onload = function () {
    audioContext.decodeAudioData(request.response, function (buffer) {
      theBuffer = buffer;
      console.log("loaded audio");
    });
  };
  request.send();

  buttons.startExerciseMajorPrompted.click(() =>
    runExerciseMajor({ prompted: true, minNote: "G3", maxNote: "G4" })
  );
  buttons.startExerciseMajorUnprompted.click(() =>
    runExerciseMajor({ prompted: false, minNote: "G3", maxNote: "G4" })
  );

  // Global Methods
  window.stopNote = function stopNote() {
    if (osc) {
      osc.stop();
      osc.disconnect();
      osc = null;
    }
  };

  window.playNote = function playNote(freq) {
    stopNote();
    osc = audioContext.createOscillator();
    osc.connect(audioContext.destination);
    osc.frequency.value = freq;
    osc.start(0);
  };

  window.stop = function stop() {
    if (pitchDetector) pitchDetector.destroy();
    pitchDetector = null;
  };

  // Stops screen from dimming
  async function getWakelock() {
    try {
      const wakeLock = await navigator.wakeLock.request("screen");
    } catch (err) {
      // the wake lock request fails - usually system related, such being low on battery
      console.log(`${err.name}, ${err.message}`);
    }
  }

  window.start = function start() {
    audioContext = new AudioContext();

    getWakelock();

    if (needsReset && pitchDetector) {
      pitchDetector.destroy();
      pitchDetector = null;
    }

    var input = inputs.input.val();
    var sourceNode;
    if (input === "osc") {
      sourceNode = audioContext.createOscillator();
      sourceNode.frequency.value = 440;
      sourceNode.start(0);
    } else if (input === "audio") {
      sourceNode = audioContext.createBufferSource();
      sourceNode.buffer = theBuffer;
      sourceNode.loop = true;
      sourceNode.start(0);
    } else {
      inputs.output.prop("checked", false);
    }
    options.input = sourceNode;

    if (inputs.output.is(":checked")) {
      options.output = audioContext.destination;
    }

    options.length = inputs.length.val() * 1;
    options.stopAfterDetection = inputs.stopAfterDetection.is(":checked");

    for (var key in options) {
      if (/^(min|max)/.test(key)) {
        delete options[key];
      }
    }

    options.minRms = 1.0 * inputs.minRms.val() || 0.01;
    var normalize = inputs.normalize.val();
    if (normalize !== "none") {
      options.normalize = normalize;
    } else {
      options.normalize = false;
    }

    var detection = inputs.detection.val();
    options.minCorrelationIncrease = false;
    options.minCorrelation = 0.9;
    if (detection === "correlation") {
      options.minCorrelation = inputs.minCorrelation.val() * 1.0;
    } else if (detection === "strength") {
      options.minCorrelationIncrease =
        inputs.minCorrelationIncrease.val() * 1.0;
    }

    var range = inputs.range.val(); // Frequency, Period, Note
    if (range !== "none") {
      options["min" + range] = inputs.min.val() * 1.0;
      options["max" + range] = inputs.max.val() * 1.0;
    }

    options.onDebug = false;
    options.onDetect = false;
    options[inputs.draw.val()] = detectCallback;

    options.context = audioContext;
    if (needsReset || !pitchDetector) {
      console.log("created PitchDetector", options);
      pitchDetector = new PitchDetector(options);
      needsReset = false;
    } else {
      pitchDetector.setOptions(options, true);
    }
    delete options.context;
    delete options.output;
    delete options.input;
    $("#settings").text(JSON.stringify(options, null, 4));
    window.pitchDetector = pitchDetector;

    var data = {};
    for (x in inputs) {
      var el = inputs[x];
      data[x] = el.val();
    }
    localStorage.setItem("pitch-detector-settings", JSON.stringify(data));

    setInterval(() => drawCanvas(canvas, pitchDetector), 50);
  };

  function detectCallback(stats, detector) {
    recordDetection(stats, detector);
    updateDetectorGUI(stats, detector);
  }

  detections = [];
  detectionsByNote = {};

  function recordDetection(stats, detector) {
    const note = detector.getNoteString();
    // Note resolves to NaN if no note is detected
    if (!note) {
      return;
    }

    const detection = {
      note,
      time: stats.time,
      detune: detector.getDetune(),
    };

    const lastRecordedDetection = detections.at(-1);
    // Rate limit recording detections
    if (
      lastRecordedDetection != null &&
      detection.time - lastRecordedDetection.time < 0.001 * SAMPLE_RATE_MS
    ) {
      return;
    }

    detections.push(detection);
    detectionsByNote[note] ??= [];
    detectionsByNote[note].push(detection);
  }

  function drawCanvas(canvas, detector) {
    if (!detector || !detector.buffer) {
      return;
    }

    const periodLength = 10;
    const currentPeriod = Math.floor(
      detector.context.currentTime / periodLength
    );
    const currentPeriodStart = currentPeriod * periodLength;
    const currentPeriodEnd = currentPeriodStart + periodLength;
    const moddedCurrentTime = detector.context.currentTime % periodLength;

    canvas.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // TODO: https://github.com/gdenisov/cardinal-spline-js smooth lines between points

    // For each note, draw a line and any detections within this period
    for (let i = 0; i < OCTAVES_SHOWN * PITCH_CLASSES.length; i++) {
      const pitchClass = PITCH_CLASSES[i % PITCH_CLASSES.length];
      const baseOctave = 3;
      const octave = Math.floor(i / PITCH_CLASSES.length) + baseOctave;
      const note = `${pitchClass}${octave}`;

      // Draw sharp notes in grey, natural notes in white
      if (pitchClass.includes("#")) {
        canvas.fillStyle = "#ccc";
      } else {
        canvas.fillStyle = "#fff";
      }
      canvas.fillRect(
        0,
        (TOTAL_NOTES_SHOWN - i) * NOTE_HEIGHT,
        CANVAS_WIDTH,
        NOTE_HEIGHT
      );

      // Draw any detections for this note within this period
      for (const detection of detectionsByNote[note] ?? []) {
        const detectionTime = detection.time;
        if (
          detectionTime < currentPeriodStart ||
          detectionTime >= currentPeriodEnd
        ) {
          continue;
        }
        const moddedDetectionTime = detectionTime % periodLength;

        // Draw the detected note
        canvas.fillStyle = COLOURS.green;
        canvas.fillRect(
          LEFT_MARGIN +
            (INNER_CANVAS_WIDTH * moddedDetectionTime) / periodLength,
          (TOTAL_NOTES_SHOWN - i) * NOTE_HEIGHT,
          2,
          NOTE_HEIGHT
        );

        // Draw the detune (ranges from -50 to 50)
        canvas.fillStyle = "#000";
        canvas.fillRect(
          LEFT_MARGIN +
            (INNER_CANVAS_WIDTH * moddedDetectionTime) / periodLength,
          (TOTAL_NOTES_SHOWN - i) * NOTE_HEIGHT +
            ((50 - detection.detune) * NOTE_HEIGHT) / 100,
          1,
          1
        );
      }

      canvas.fillStyle = "#000";
      canvas.fillText(note, 10, 11 + (TOTAL_NOTES_SHOWN - i) * NOTE_HEIGHT);
    }

    // Draw the time marker
    canvas.fillStyle = "#f00";
    canvas.fillRect(
      LEFT_MARGIN + (INNER_CANVAS_WIDTH * moddedCurrentTime) / periodLength,
      0,
      1,
      CANVAS_HEIGHT
    );
  }

  function updateDetectorGUI(stats, detector) {
    // Update Pitch Detection GUI
    if (!stats.detected) {
      gui.detector.attr("class", "vague");
      gui.pitch.text("--");
      gui.note.text("-");
      gui.detuneBox.attr("class", "");
      gui.detune.text("--");
    } else {
      gui.detector.attr("class", "confident");
      var note = detector.getNoteNumber();
      var detune = detector.getDetune();
      gui.pitch.text(Math.round(stats.frequency));
      gui.note.text(detector.getNoteString());
      if (detune === 0) {
        gui.detuneBox.attr("class", "");
        gui.detune.text("--");
      } else {
        if (detune < 0) gui.detuneBox.attr("class", "flat");
        else gui.detuneBox.attr("class", "sharp");
        gui.detune.text(Math.abs(detune));
      }
    }
  }

  async function detectHeldNote(lengthMs) {
    const maxSamples = lengthMs / SAMPLE_RATE_MS;

    // If no detections have been made, we can't slice from -1
    const lastDetectionIndexAtStart = Math.max(detections.length - 1, 0);
    while (true) {
      await sleep(SAMPLE_RATE_MS * 10);
      const detectionsSinceStart = detections.slice(lastDetectionIndexAtStart);

      if (detectionsSinceStart.length < maxSamples / GAPPINESS) {
        continue;
      }

      const lastDetection = detectionsSinceStart.at(-1);
      const lastDetectionTime = lastDetection.time;
      const detectionsWithinLength = detectionsSinceStart.filter(
        (detection) => detection.time >= lastDetectionTime - lengthMs / 1000
      );

      if (detectionsWithinLength.length < maxSamples / GAPPINESS) {
        continue;
      }

      const noteCounts = detectionsWithinLength.reduce((counts, detection) => {
        counts[detection.note] = counts[detection.note] + 1 || 1;
        return counts;
      }, {});

      const modalNote = Object.keys(noteCounts).reduce((a, b) =>
        noteCounts[a] > noteCounts[b] ? a : b
      );
      const modalNotePercentage = Math.floor(
        (100 * noteCounts[modalNote]) / detectionsWithinLength.length
      );
      const majorityNote = Object.keys(noteCounts).find(
        (note) => noteCounts[note] > detectionsWithinLength.length * 0.9
      );

      return { modalNote, modalNotePercentage, majorityNote };
    }
  }

  async function runExerciseMajor({ prompted, minNote, maxNote }) {
    const notes = (function* () {
      while (true) {
        for (const note of EXERCISE_NOTE_ORDER_MAJOR.keys()) {
          yield note;
        }
      }
    })();

    while (true) {
      const note = notes.next().value;
      const midiNumber = EXERCISE_NOTE_ORDER_MAJOR.get(note);
      if (minNote && midiNumber < EXERCISE_NOTE_ORDER_MAJOR.get(minNote)) {
        continue;
      }
      if (maxNote && midiNumber > EXERCISE_NOTE_ORDER_MAJOR.get(maxNote)) {
        continue;
      }

      const frequency =
        window.PitchDetector.prototype.noteToFrequency(midiNumber);

      while (true) {
        if (prompted) {
          playNote(frequency);
          await sleep(1000);
          stopNote();
        }

        const heldNote = await detectHeldNote(1000);

        gui.exerciseHeader.text(
          `${heldNote.modalNote} (${heldNote.modalNotePercentage}%)`
        );

        const isCorrect = heldNote.majorityNote === note;

        if (isCorrect) {
          gui.exerciseNote.text("🌟");
        } else {
          gui.exerciseNote.text("🌚");
        }

        await sleep(1000);
        if (isCorrect) {
          break;
        } else {
          gui.exerciseNote.text(note);
        }
      }
    }
  }
});
