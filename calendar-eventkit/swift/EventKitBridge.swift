import Foundation
import EventKit
import AppKit

let store = EKEventStore()

// MARK: - Output

func succeed(_ data: Any) -> Never {
    emit(["ok": true, "data": data])
    exit(0)
}

func fail(_ message: String) -> Never {
    emit(["ok": false, "error": message])
    exit(1)
}

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

// MARK: - RunLoop wait (safe for main-thread callbacks)

func waitUntil(timeout: TimeInterval = 10, _ condition: () -> Bool) -> Bool {
    let deadline = Date(timeIntervalSinceNow: timeout)
    while !condition() {
        if Date() >= deadline { return false }
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    return true
}

// MARK: - Calendar access

func requestAccess() {
    var done = false
    var granted = false

    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { g, _ in
            granted = g; done = true
        }
    } else {
        store.requestAccess(to: .event) { g, _ in
            granted = g; done = true
        }
    }

    guard waitUntil({ done }) && granted else {
        fail("Calendar access denied. Grant access in System Settings > Privacy & Security > Calendars.")
    }
}

// MARK: - Date helpers

let isoFmt: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

let isoFmtFrac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func parseDate(_ s: String) -> Date? {
    isoFmt.date(from: s) ?? isoFmtFrac.date(from: s)
}

func fmtDate(_ d: Date) -> String { isoFmt.string(from: d) }

// MARK: - Serialization

func colorHex(_ c: EKCalendar) -> String {
    guard let srgb = c.color.usingColorSpace(.sRGB) else { return "#808080" }
    let r = Int((srgb.redComponent   * 255).rounded())
    let g = Int((srgb.greenComponent * 255).rounded())
    let b = Int((srgb.blueComponent  * 255).rounded())
    return String(format: "#%02X%02X%02X", r, g, b)
}

func calTypeStr(_ t: EKCalendarType) -> String {
    switch t {
    case .local:        return "local"
    case .calDAV:       return "calDAV"
    case .exchange:     return "exchange"
    case .subscription: return "subscription"
    case .birthday:     return "birthday"
    @unknown default:   return "unknown"
    }
}

func serCal(_ cal: EKCalendar) -> [String: Any] {
    ["id": cal.calendarIdentifier,
     "title": cal.title,
     "type": calTypeStr(cal.type),
     "color": colorHex(cal),
     "isEditable": !cal.isImmutable]
}

func serEvent(_ e: EKEvent) -> [String: Any] {
    var d: [String: Any] = [
        "id":                e.eventIdentifier ?? "",
        "title":             e.title ?? "(No Title)",
        "start":             fmtDate(e.startDate),
        "end":               fmtDate(e.endDate),
        "allDay":            e.isAllDay,
        "calendar":          serCal(e.calendar),
        "hasRecurrenceRules": e.hasRecurrenceRules
    ]
    if let v = e.location, !v.isEmpty { d["location"] = v }
    if let v = e.notes,    !v.isEmpty { d["notes"]    = v }
    if let v = e.url                  { d["url"]      = v.absoluteString }
    if let alarms = e.alarms, !alarms.isEmpty {
        let mins = alarms.compactMap { a -> Int? in
            guard a.relativeOffset <= 0 else { return nil }
            return Int(-a.relativeOffset / 60)
        }
        if !mins.isEmpty { d["alertMinutes"] = mins }
    }
    return d
}

// MARK: - Helpers

func findCal(_ nameOrId: String) -> EKCalendar? {
    let cals = store.calendars(for: .event)
    return cals.first { $0.calendarIdentifier == nameOrId }
        ?? cals.first { $0.title.lowercased() == nameOrId.lowercased() }
}

func parsePayload(_ s: String) -> [String: Any]? {
    guard let d = s.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
}

// MARK: - Commands

func cmdListCalendars() {
    succeed(store.calendars(for: .event).map { serCal($0) })
}

func cmdListEvents(_ args: ArraySlice<String>) {
    let a = Array(args)
    guard a.count >= 2 else { fail("list_events requires <start> <end> [calendarId]") }
    guard let start = parseDate(a[0]), let end = parseDate(a[1]) else {
        fail("Invalid date format")
    }
    var cals: [EKCalendar]? = nil
    if a.count >= 3 {
        guard let cal = findCal(a[2]) else { fail("Calendar not found: \(a[2])") }
        cals = [cal]
    }
    let pred = store.predicateForEvents(withStart: start, end: end, calendars: cals)
    let events = store.events(matching: pred).sorted { $0.startDate < $1.startDate }
    succeed(events.map { serEvent($0) })
}

func cmdGetEvent(_ args: ArraySlice<String>) {
    guard let id = args.first else { fail("get_event requires <id>") }
    guard let ev = store.event(withIdentifier: id) else { fail("Event not found: \(id)") }
    succeed(serEvent(ev))
}

func cmdCreateEvent(_ args: ArraySlice<String>) {
    guard let js = args.first, let p = parsePayload(js) else { fail("create_event requires valid JSON") }
    guard let title    = p["title"]    as? String                                else { fail("title is required") }
    guard let startStr = p["start"]    as? String, let start = parseDate(startStr) else { fail("valid start required") }
    guard let endStr   = p["end"]      as? String, let end   = parseDate(endStr)   else { fail("valid end required") }

    let ev = EKEvent(eventStore: store)
    ev.title     = title
    ev.startDate = start
    ev.endDate   = end
    ev.isAllDay  = p["allDay"] as? Bool ?? false
    if let v = p["location"] as? String { ev.location = v }
    if let v = p["notes"]    as? String { ev.notes    = v }
    if let v = p["url"]      as? String, let u = URL(string: v) { ev.url = u }
    ev.calendar = (p["calendar"] as? String).flatMap { findCal($0) } ?? store.defaultCalendarForNewEvents
    if let m = p["alertMinutes"] as? Int {
        ev.addAlarm(EKAlarm(relativeOffset: TimeInterval(-m * 60)))
    }
    do {
        try store.save(ev, span: .thisEvent)
        succeed(serEvent(ev))
    } catch { fail("Save failed: \(error.localizedDescription)") }
}

func cmdUpdateEvent(_ args: ArraySlice<String>) {
    let a = Array(args)
    guard a.count >= 2 else { fail("update_event requires <id> <json>") }
    guard let ev = store.event(withIdentifier: a[0]) else { fail("Event not found: \(a[0])") }
    guard let p = parsePayload(a[1]) else { fail("Invalid JSON payload") }

    if let v = p["title"]    as? String                      { ev.title     = v }
    if let v = p["start"]    as? String, let d = parseDate(v) { ev.startDate = d }
    if let v = p["end"]      as? String, let d = parseDate(v) { ev.endDate   = d }
    if let v = p["allDay"]   as? Bool                        { ev.isAllDay  = v }
    if let v = p["location"] as? String                      { ev.location  = v }
    if let v = p["notes"]    as? String                      { ev.notes     = v }
    if let v = p["url"]      as? String, let u = URL(string: v) { ev.url    = u }
    if let v = p["calendar"] as? String, let c = findCal(v)  { ev.calendar  = c }
    if let m = p["alertMinutes"] as? Int {
        ev.alarms = nil
        ev.addAlarm(EKAlarm(relativeOffset: TimeInterval(-m * 60)))
    }
    let span: EKSpan = (p["allFuture"] as? Bool == true) ? .futureEvents : .thisEvent
    do {
        try store.save(ev, span: span)
        succeed(serEvent(ev))
    } catch { fail("Update failed: \(error.localizedDescription)") }
}

func cmdDeleteEvent(_ args: ArraySlice<String>) {
    let a = Array(args)
    guard let id = a.first else { fail("delete_event requires <id>") }
    guard let ev = store.event(withIdentifier: id) else { fail("Event not found: \(id)") }
    let span: EKSpan = (a.count >= 2 && a[1] == "all") ? .futureEvents : .thisEvent
    do {
        try store.remove(ev, span: span)
        succeed(["deleted": true, "id": id])
    } catch { fail("Delete failed: \(error.localizedDescription)") }
}

func cmdSearchEvents(_ args: ArraySlice<String>) {
    guard let q = args.first, !q.isEmpty else { fail("search_events requires <query>") }
    let now  = Date()
    let start = Calendar.current.date(byAdding: .day, value: -90,  to: now)!
    let end   = Calendar.current.date(byAdding: .day, value:  365, to: now)!
    let pred  = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let lower = q.lowercased()
    let hits  = store.events(matching: pred).filter {
        ($0.title?.lowercased().contains(lower) ?? false) ||
        ($0.notes?.lowercased().contains(lower) ?? false) ||
        ($0.location?.lowercased().contains(lower) ?? false)
    }.sorted { $0.startDate < $1.startDate }
    succeed(hits.map { serEvent($0) })
}

// MARK: - Main

let argv = CommandLine.arguments
guard argv.count >= 2 else { fail("Usage: eventkit-bridge <command> [args...]") }

requestAccess()

let cmd      = argv[1]
let restArgs = argv.dropFirst(2)

switch cmd {
case "list_calendars":  cmdListCalendars()
case "list_events":     cmdListEvents(restArgs)
case "get_event":       cmdGetEvent(restArgs)
case "create_event":    cmdCreateEvent(restArgs)
case "update_event":    cmdUpdateEvent(restArgs)
case "delete_event":    cmdDeleteEvent(restArgs)
case "search_events":   cmdSearchEvents(restArgs)
default:                fail("Unknown command: \(cmd)")
}
