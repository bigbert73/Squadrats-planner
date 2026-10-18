import Toybox.Application;
import Toybox.Background;
import Toybox.Lang;
import Toybox.Time;
import Toybox.WatchUi;

// Squadrats data field: a north-up mini map of collected squadrats and
// squadratinhos around the rider, plus what this ride has collected so far.
// A background service refreshes the area from the Squadrats Planner server
// every 5 minutes through the phone; the last area is kept in Storage, so the
// field also works without the phone.
(:background)
class SquadratsApp extends Application.AppBase {
    var field = null;

    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() {
        if (Background has :registerForTemporalEvent) {
            Background.registerForTemporalEvent(new Time.Duration(5 * 60));
        }
        field = new SquadratsField();
        return [ field ];
    }

    function getServiceDelegate() {
        return [ new AreaService() ];
    }

    function onBackgroundData(data) {
        // Back to the regular 5-minute refresh (a first fix or leaving the
        // area asks for an immediate one-off run, see SquadratsField)
        if (Background has :registerForTemporalEvent) {
            Background.registerForTemporalEvent(new Time.Duration(5 * 60));
        }
        if (data instanceof Dictionary && data.hasKey("sqi")) {
            Application.Storage.setValue("area", data);
            if (field != null) {
                field.loadArea(data);
            }
        } else if (field != null) {
            field.setStatus(data);
        }
    }
}
