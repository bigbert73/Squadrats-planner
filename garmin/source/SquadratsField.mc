import Toybox.Activity;
import Toybox.Application;
import Toybox.Attention;
import Toybox.Background;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.Position;
import Toybox.StringUtil;
import Toybox.Time;
import Toybox.WatchUi;

class SquadratsField extends WatchUi.DataField {
    // squadratinho = z17 tile, squadrat = z14 tile = 8x8 squadratinhos
    const Z17 = 131072.0d;
    const C_OWNED = 0x1E8E3E;
    const C_NEW = 0xFFD600;
    const C_BLOCKED = 0x555555;
    const C_SQ_EDGE = 0xFF6D00;

    // area from the server: bitmaps (row-major, MSB first) with their origins
    hidden var ix, iy, n, sqi, blk;
    hidden var sx, sy, m, sq;
    // rider position in z17 tile coordinates
    hidden var fx = null, fy = null, heading = 0.0;
    hidden var lastSaved = null;
    // collected during this ride (keys: tx << 20 | ty)
    hidden var rideSqi = {}, rideSq = {};
    hidden var nSqi = 0, nSq = 0;
    hidden var status = null;

    function initialize() {
        DataField.initialize();
        var a = Application.Storage.getValue("area");
        if (a != null) {
            loadArea(a);
        }
    }

    function loadArea(a) {
        ix = a["ix"]; iy = a["iy"]; n = a["n"];
        sx = a["sx"]; sy = a["sy"]; m = a["m"];
        sqi = hex(a["sqi"]); blk = hex(a["blk"]); sq = hex(a["sq"]);
        status = null;
        WatchUi.requestUpdate();
    }

    function setStatus(s) {
        status = s;
    }

    hidden function hex(s) {
        return StringUtil.convertEncodedString(s, {
            :fromRepresentation => StringUtil.REPRESENTATION_STRING_HEX,
            :toRepresentation => StringUtil.REPRESENTATION_BYTE_ARRAY
        });
    }

    // 1 / 0, or -1 outside the bitmap
    hidden function bit(arr, size, x, y) {
        if (arr == null || x < 0 || y < 0 || x >= size || y >= size) {
            return -1;
        }
        var i = y * size + x;
        return (arr[i >> 3] >> (7 - (i & 7))) & 1;
    }

    hidden function key(x, y) {
        return (x.toLong() << 20) | y.toLong();
    }

    function compute(info as Activity.Info) as Void {
        // Before the timer starts the activity may not report a location yet;
        // fall back to the device's own fix
        var loc = info.currentLocation;
        if (loc == null) {
            var p = Position.getInfo();
            if (p != null && p.accuracy != Position.QUALITY_NOT_AVAILABLE) {
                loc = p.position;
            }
        }
        if (loc == null) {
            return;
        }
        var d = loc.toDegrees();
        var lat = d[0].toDouble(), lng = d[1].toDouble();
        fx = (lng + 180.0d) / 360.0d * Z17;
        var r = Math.toRadians(lat);
        fy = (1.0d - Math.ln(Math.tan(r) + 1.0d / Math.cos(r)) / Math.PI) / 2.0d * Z17;
        if (info.currentHeading != null) {
            heading = info.currentHeading;
        }

        // Tell the background service where we are (only after ~500 m moves)
        if (lastSaved == null || (lastSaved[0] - lat).abs() > 0.005 || (lastSaved[1] - lng).abs() > 0.008) {
            lastSaved = [lat, lng];
            Application.Storage.setValue("pos", [lat.toFloat(), lng.toFloat()]);
            // No area yet, or riding off the edge of it: refresh now rather
            // than at the next 5-minute tick (Garmin still enforces 5 min
            // between runs; an earlier request waits for that)
            if (sqi == null || (fx - ix - n / 2).abs() > n / 3 || (fy - iy - n / 2).abs() > n / 3) {
                refreshSoon();
            }
        }

        // A background run that never got an answer (killed by the system)
        // doesn't reach onBackgroundData, which is what re-registers the
        // 5-minute refresh; put it back here
        if ((Background has :getTemporalEventRegisteredTime) && Background.getTemporalEventRegisteredTime() == null) {
            try {
                Background.registerForTemporalEvent(new Time.Duration(5 * 60));
            } catch (e) {
            }
        }

        // Collect only while the activity is recording
        if (info.timerState != Activity.TIMER_STATE_ON || sqi == null) {
            return;
        }
        var tx = fx.toNumber(), ty = fy.toNumber();
        var gained = false;
        if (bit(sqi, n, tx - ix, ty - iy) == 0 && !rideSqi.hasKey(key(tx, ty))) {
            rideSqi.put(key(tx, ty), true);
            nSqi++;
            gained = true;
        }
        var qx = tx >> 3, qy = ty >> 3;
        if (bit(sq, m, qx - sx, qy - sy) == 0 && !rideSq.hasKey(key(qx, qy))) {
            rideSq.put(key(qx, qy), true);
            nSq++;
            gained = true;
        }
        if (gained && Attention has :playTone) {
            Attention.playTone(Attention.TONE_KEY);
        }
    }

    // One-off background run as soon as Garmin allows: a Moment earlier than
    // 5 minutes after the previous run throws InvalidBackgroundTimeException
    hidden function refreshSoon() {
        if (!(Background has :registerForTemporalEvent)) {
            return;
        }
        var at = Time.now();
        var last = Background.getLastTemporalEventTime();
        if (last != null) {
            var next = last.add(new Time.Duration(5 * 60 + 2));
            if (next.greaterThan(at)) {
                at = next;
            }
        }
        try {
            Background.registerForTemporalEvent(at);
        } catch (e) {
            // the regular 5-minute event registered at start stays in place
        }
    }

    // While waiting: when the background service last ran and what is
    // scheduled next, to tell "never runs" from "runs but gets nothing"
    hidden function bgInfo() {
        if (!(Background has :getLastTemporalEventTime)) {
            return "tlo: brak";
        }
        var now = Time.now().value();
        var last = Background.getLastTemporalEventTime();
        var reg = Background.getTemporalEventRegisteredTime();
        var s = "tlo: " + (last == null ? "nigdy" : (now - last.value()) + "s temu");
        if (reg == null) {
            s += ", brak planu";
        } else if (reg instanceof Time.Duration) {
            s += ", co " + reg.value() + "s";
        } else {
            s += ", za " + (reg.value() - now) + "s";
        }
        return s;
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth(), h = dc.getHeight();
        var bg = getBackgroundColor();
        var dark = bg == Graphics.COLOR_BLACK;
        var fg = dark ? Graphics.COLOR_WHITE : Graphics.COLOR_BLACK;
        dc.setColor(bg, bg);
        dc.clear();

        if (sqi == null || fx == null) {
            var msg = fx == null ? "Squadrats: czekam na GPS" : "Squadrats: czekam na dane";
            if (status != null) {
                msg += "\n(" + status + ")";
            }
            msg += "\n" + bgInfo();
            dc.setColor(fg, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, h / 2, Graphics.FONT_XTINY, msg,
                Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
            return;
        }

        // Small field: just the counters
        if (h < 100) {
            drawCounters(dc, w, h / 2 - 12, fg, false);
            return;
        }

        var ts = h < 200 ? 12 : 18;               // px per squadratinho
        var cx = w / 2, cy = h / 2;
        var lx = fx - ix, ly = fy - iy;           // rider in bitmap coordinates
        var hx = cx / ts + 1, hy = cy / ts + 1;
        var x0 = lx.toNumber() - hx, x1 = lx.toNumber() + hx;
        var y0 = ly.toNumber() - hy, y1 = ly.toNumber() + hy;
        var grid = dark ? 0x333333 : 0xCCCCCC;
        var outside = dark ? 0x111111 : 0xEEEEEE;
        var ox = cx - (lx * ts).toNumber(), oy = cy - (ly * ts).toNumber();   // pixel of bitmap (0,0)
        var anyNew = nSqi > 0;

        // Kept cheap: a full-screen field is ~500 cells every second and the
        // watchdog stops apps that run too long per update
        for (var y = y0; y <= y1; y++) {
            var py = oy + y * ts;
            var inY = y >= 0 && y < n;
            for (var x = x0; x <= x1; x++) {
                var col = null;
                if (!inY || x < 0 || x >= n) {
                    col = outside;
                } else {
                    var i = y * n + x;
                    var sh = 7 - (i & 7);
                    if (anyNew && rideSqi.hasKey(key(ix + x, iy + y))) {
                        col = C_NEW;
                    } else if ((sqi[i >> 3] >> sh) & 1) {
                        col = C_OWNED;
                    } else if (blk != null && ((blk[i >> 3] >> sh) & 1)) {
                        col = C_BLOCKED;
                    }
                }
                if (col != null) {
                    dc.setColor(col, col);
                    dc.fillRectangle(ox + x * ts, py, ts, ts);
                }
            }
        }
        dc.setColor(grid, Graphics.COLOR_TRANSPARENT);
        for (var x = x0; x <= x1 + 1; x++) {
            dc.drawLine(ox + x * ts, 0, ox + x * ts, h);
        }
        for (var y = y0; y <= y1 + 1; y++) {
            dc.drawLine(0, oy + y * ts, w, oy + y * ts);
        }

        // Squadrats not collected yet: thick orange outline
        dc.setPenWidth(3);
        dc.setColor(C_SQ_EDGE, Graphics.COLOR_TRANSPARENT);
        for (var qy = (iy + y0) >> 3; qy <= (iy + y1) >> 3; qy++) {
            for (var qx = (ix + x0) >> 3; qx <= (ix + x1) >> 3; qx++) {
                if (bit(sq, m, qx - sx, qy - sy) == 0 && !rideSq.hasKey(key(qx, qy))) {
                    var px = ox + (qx * 8 - ix) * ts;
                    var py = oy + (qy * 8 - iy) * ts;
                    dc.drawRectangle(px, py, ts * 8 + 1, ts * 8 + 1);
                }
            }
        }
        dc.setPenWidth(1);

        drawRider(dc, cx, cy, fg);
        drawCounters(dc, w, 8, fg, true);
    }

    hidden function drawRider(dc, cx, cy, fg) {
        var s = Math.sin(heading), c = Math.cos(heading);
        var pts = [[0, -11], [7, 8], [0, 4], [-7, 8]];
        var poly = [];
        for (var i = 0; i < pts.size(); i++) {
            var x = pts[i][0], y = pts[i][1];
            poly.add([cx + (x * c - y * s).toNumber(), cy + (x * s + y * c).toNumber()]);
        }
        dc.setColor(0x2979FF, Graphics.COLOR_TRANSPARENT);
        dc.fillPolygon(poly);
        dc.setColor(fg, Graphics.COLOR_TRANSPARENT);
        for (var i = 0; i < poly.size(); i++) {
            var a = poly[i], b = poly[(i + 1) % poly.size()];
            dc.drawLine(a[0], a[1], b[0], b[1]);
        }
    }

    hidden function drawCounters(dc, w, y, fg, boxed) {
        var txt = "+" + nSq + " SQ   +" + nSqi + " SQI";
        if (boxed) {
            var bw = dc.getTextWidthInPixels(txt, Graphics.FONT_SMALL) + 16;
            dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
            dc.fillRoundedRectangle((w - bw) / 2, y, bw, 30, 6);
            dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        } else {
            dc.setColor(fg, Graphics.COLOR_TRANSPARENT);
        }
        dc.drawText(w / 2, y + 2, Graphics.FONT_SMALL, txt, Graphics.TEXT_JUSTIFY_CENTER);
    }
}
