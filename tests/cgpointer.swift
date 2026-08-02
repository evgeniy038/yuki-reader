import CoreGraphics
import Foundation

// Real-input pointer driver: moves the actual system cursor (HID level), so
// OS/Chrome fullscreen UI reacts exactly as with a physical trackpad.
//   swift tests/cgpointer.swift move X Y
//   swift tests/cgpointer.swift click X Y

let args = CommandLine.arguments
guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else {
    FileHandle.standardError.write("usage: cgpointer.swift move|click X Y\n".data(using: .utf8)!)
    exit(2)
}
let mode = args[1]
let point = CGPoint(x: x, y: y)

func post(_ type: CGEventType, _ p: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?
        .post(tap: .cghidEventTap)
}

CGWarpMouseCursorPosition(point)
post(.mouseMoved, point)
if mode == "click" {
    usleep(120_000)
    post(.leftMouseDown, point)
    usleep(90_000)
    post(.leftMouseUp, point)
}
// Report where the system cursor actually ended up (global display points).
if let loc = CGEvent(source: nil)?.location {
    print("cursor at \(Int(loc.x)),\(Int(loc.y))")
}
