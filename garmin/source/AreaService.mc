import Toybox.Application;
import Toybox.Background;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.System;

// Background service: asks the server for the squares around the last known
// position (written to Storage by the field). Runs through the phone, so the
// server must be HTTPS with a valid certificate.
(:background)
class AreaService extends System.ServiceDelegate {

    function initialize() {
        ServiceDelegate.initialize();
    }

    function onTemporalEvent() as Void {
        var pos = Application.Storage.getValue("pos");
        var key = Application.Properties.getValue("apiKey");
        var url = Application.Properties.getValue("serverUrl");
        if (pos == null || key == null || url == null || key.equals("")) {
            Background.exit(pos == null ? "nogps" : "nokey");
            return;
        }
        Communications.makeWebRequest(
            url + "/api/garmin/area",
            { "key" => key, "lat" => pos[0], "lng" => pos[1] },
            {
                :method => Communications.HTTP_REQUEST_METHOD_GET,
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
            },
            method(:onReceive)
        );
    }

    function onReceive(code as Number, data as Dictionary or String or Null) as Void {
        if (code == 200 && data instanceof Dictionary) {
            Background.exit(data);
        } else {
            Background.exit("http" + code);
        }
    }
}
