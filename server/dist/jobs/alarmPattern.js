// The vibration firmware is on the cover. Mixed or unknown hardware uses double.
export const supportsRisePattern = (hubVersion, coverVersion) => hubVersion === 'Pod 5' && coverVersion === 'Pod 5';
export const alarmPatternFor = (hubVersion, coverVersion, chosen) => supportsRisePattern(hubVersion, coverVersion) ? chosen : 'double';
//# sourceMappingURL=alarmPattern.js.map