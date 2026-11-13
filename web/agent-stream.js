(function () {
  function clean(value, max) {
    return String(value == null ? "" : value).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
  }
  function lineEnd(value) {
    const newline = value.indexOf("\n");
    const carriage = value.indexOf("\r");
    if (newline < 0) return carriage;
    if (carriage < 0) return newline;
    return Math.min(newline, carriage);
  }
  function afterLine(value, index) {
    let rest = value.slice(index + 1);
    if (rest.startsWith("\n")) rest = rest.slice(1);
    return rest;
  }
  function streamLead(raw) {
    if (!raw || typeof raw !== "object") return null;
    const company = clean(raw.company, 200);
    if (!company) return null;
    return {
      company: company,
      domain: clean(raw.domain, 200),
      website: clean(raw.website, 300),
      hq: clean(raw.hq, 300),
      contact: clean(raw.contact, 200),
      title: clean(raw.title, 200),
      email: clean(raw.email, 200),
      pain: clean(raw.pain, 500),
      hook: clean(raw.hook, 500),
      priority: /high/i.test(String(raw.priority || "")) ? "High" : "Low",
      source: clean(raw.source, 500),
      photo: clean(raw.photo, 500)
    };
  }
  function eventFromRow(row) {
    if (!row || typeof row !== "object") return null;
    if (row.type === "summary") return { type: "summary", explanation: clean(row.explanation, 600) };
    if (row.type === "lead") {
      const lead = streamLead(row);
      return lead ? { type: "lead", lead: lead } : null;
    }
    if (row.type === "done") return { type: "done", count: Number(row.count) || 0 };
    if (row.type === "error") return { type: "error", error: clean(row.error || row.message || row.content, 300) || "The lead webhook refused the request." };
    return null;
  }
  function createAgentStreamParser() {
    let chunkBuf = "";
    let textBuf = "";
    function drainText() {
      const events = [];
      let index = lineEnd(textBuf);
      while (index >= 0) {
        const line = textBuf.slice(0, index).trim();
        textBuf = afterLine(textBuf, index);
        if (line) {
          try {
            const event = eventFromRow(JSON.parse(line));
            if (event) events.push(event);
          } catch (error) { /* a partial content piece is not a lead yet */ }
        }
        index = lineEnd(textBuf);
      }
      return events;
    }
    function takeChunk(line) {
      if (!line) return [];
      let chunk;
      try { chunk = JSON.parse(line); } catch (error) { return []; }
      if (!chunk || typeof chunk !== "object") return [];
      if (chunk.type === "item") {
        if (typeof chunk.content !== "string" || !chunk.content) return [];
        textBuf += chunk.content;
        return drainText();
      }
      const direct = eventFromRow(chunk);
      return direct ? [direct] : [];
    }
    return {
      push(text) {
        chunkBuf += String(text || "");
        const events = [];
        let index = lineEnd(chunkBuf);
        while (index >= 0) {
          const line = chunkBuf.slice(0, index).trim();
          chunkBuf = afterLine(chunkBuf, index);
          events.push.apply(events, takeChunk(line));
          index = lineEnd(chunkBuf);
        }
        return events;
      },
      finish() {
        const events = [];
        if (chunkBuf.trim()) {
          const line = chunkBuf.trim();
          chunkBuf = "";
          events.push.apply(events, takeChunk(line));
        }
        events.push.apply(events, drainText());
        if (textBuf.trim()) {
          try {
            const event = eventFromRow(JSON.parse(textBuf.trim()));
            if (event) events.push(event);
          } catch (error) { /* the last content piece was not a complete line */ }
          textBuf = "";
        }
        return events;
      }
    };
  }
  window.AgentStream = { createAgentStreamParser: createAgentStreamParser };
})();
