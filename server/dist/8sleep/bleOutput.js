// Parsing for bluetoothctl output lines. The control characters are the
// point: bluetoothctl wraps its output in them, so the disables below are the
// rule not fitting, not a smell.
export function cleanBleLine(line) {
    return (line
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // Remove ANSI escape sequences
        // eslint-disable-next-line no-control-regex
        .replace(/\u0001\x1b\[.*?\u0001\x1b\[.*?\u0002/g, '') // Remove specific color codes
        // eslint-disable-next-line no-control-regex
        .replace(/\u0001.*?\u0002/g, '') // Remove other control sequences
        .replace(/\r/g, '') // Remove carriage returns
        .replace(/\[[^\]]*\]/g, '') // Remove bracketed tags such as [CHG] and the prompt
    );
}
const MAC_ADDRESS = /\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b/g;
// Bytes from any 2-digit hex words on the line. processNotificationBuffer
// handles framing (the 0xff 0xff 0xff 0xff header) and validation.
export function notificationBytes(line) {
    const hexPairs = cleanBleLine(line).replace(MAC_ADDRESS, '').match(/\b[0-9a-fA-F]{2}\b/g);
    return hexPairs ? hexPairs.map((s) => parseInt(s, 16)) : [];
}
//# sourceMappingURL=bleOutput.js.map