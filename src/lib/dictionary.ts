// Preset deflate dictionary shared by encodeBundle and decodeBundle. A bundle
// under a kilobyte has no history of its own to find repeats in, so this
// supplies one: the boilerplate of what people send by hand (contacts,
// calendar events, Wi-Fi strings, URLs, short messages) plus the bundle's
// own manifest JSON. Likelier matches sit nearer the end, where deflate's
// distance codes are cheaper. Hand-written: nobody uses the app yet, so there
// are no real samples to train on.
//
// Changing one byte here changes every bundle on the wire. Bump
// PROTOCOL_VERSION when you do, and update the golden in bundle.test.ts.
export const DICTIONARY: Uint8Array = new TextEncoder().encode([
  // vCard 3.0 as iOS exports it
  "BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Apple Inc.//iPhone OS 18.0//EN\r\n" +
  "N:;;;;\r\nFN:\r\nORG:\r\nTITLE:\r\nNICKNAME:\r\n" +
  "TEL;type=CELL;type=VOICE;type=pref:\r\nTEL;type=HOME;type=VOICE:\r\n" +
  "TEL;type=WORK;type=VOICE:\r\nTEL;type=IPHONE;type=CELL;type=VOICE:\r\n" +
  "EMAIL;type=INTERNET;type=HOME;type=pref:\r\nEMAIL;type=INTERNET;type=WORK:\r\n" +
  "ADR;type=HOME;type=pref:;;\r\nADR;type=WORK:;;\r\n" +
  "item1.URL;type=pref:\r\nitem1.X-ABLabel:_$!<HomePage>!$_\r\n" +
  "item2.X-ABDATE;type=pref:\r\nitem2.X-ABLabel:_$!<Anniversary>!$_\r\n" +
  "BDAY:\r\nNOTE:\r\nPHOTO;ENCODING=b;TYPE=JPEG:\r\nEND:VCARD\r\n",
  // vCard 4.0 as Android exports it
  "BEGIN:VCARD\nVERSION:4.0\nN:;;;;\nFN:\nTEL;TYPE=cell:\nTEL;TYPE=home:\n" +
  "EMAIL;TYPE=home:\nADR;TYPE=home:;;\nEND:VCARD\n",
  // iCalendar event
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:\r\nBEGIN:VEVENT\r\nUID:\r\n" +
  "DTSTAMP:\r\nDTSTART;TZID=America/Denver:\r\nDTEND;TZID=America/Denver:\r\n" +
  "SUMMARY:\r\nLOCATION:\r\nDESCRIPTION:\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  // Wi-Fi QR string
  "WIFI:T:WPA;S:;P:;H:false;;",
  // URL pieces
  "https://www.youtube.com/watch?v= https://youtu.be/ https://maps.google.com/" +
  " https://maps.apple.com/ https://github.com/ https://docs.google.com/" +
  " https://drive.google.com/ https://zoom.us/j/ https://meet.google.com/" +
  " https://www.instagram.com/ https://x.com/ mailto: tel:+1 sms:+1" +
  " ?utm_source=&utm_medium=&utm_campaign= .com/ .org/ .net/ .dev/ http:// https://www.",
  // English
  "the and that have for not with you this but his from they she her will one" +
  " all would there their what out about who get which when make can like time" +
  " just him know take people into year your good some could them see other" +
  " than then now look only come its over think also back after use two how our" +
  " work first well way even new want because any these give day most us" +
  " hello hi hey thanks thank you please here is sorry see you tomorrow today" +
  " tonight morning afternoon call me text me let me know meeting address" +
  " phone number email password name home work",
  // Spanish
  "que de no a la el es y en lo un por qué me una te los se con para mi está" +
  " si bien pero yo eso las sí su tu aquí del al como le más esto ya todo esta" +
  " vamos muy hay ahora algo estoy puedo gracias hola buenos días buenas tardes" +
  " noches mañana hermano hermana nos vemos por favor dirección teléfono correo",
  // Manifest values
  "image/jpeg image/png image/heic image/webp image/gif application/pdf" +
  " application/octet-stream application/json text/vcard text/calendar" +
  " text/html video/mp4 video/quicktime audio/mpeg" +
  " .jpg .jpeg .png .pdf .vcf .ics .heic .mov .mp4 .txt .zip IMG_ Screenshot",
  // Manifest JSON, one text item
  '"},{"name":"',
  '{"items":[{"name":"message.txt","type":"text/plain","size":',
  "}]}",
].join("\n"));
