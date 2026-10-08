import AppKit

// Original vector artwork; no host-app artwork or external asset is copied.
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
func draw(_ pixels: Int, _ file: String) throws {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                              colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let scale = CGFloat(pixels) / 1024
    let transform = NSAffineTransform(); transform.scale(by: scale); transform.concat()
    NSColor.clear.setFill(); NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()
    let background = NSBezierPath(roundedRect: NSRect(x: 42, y: 42, width: 940, height: 940), xRadius: 212, yRadius: 212)
    NSGradient(starting: NSColor(calibratedRed: 0.11, green: 0.19, blue: 0.42, alpha: 1),
               ending: NSColor(calibratedRed: 0.22, green: 0.36, blue: 0.68, alpha: 1))!.draw(in: background, angle: 65)
    let paper = NSBezierPath(roundedRect: NSRect(x: 239, y: 186, width: 546, height: 662), xRadius: 54, yRadius: 54)
    NSColor(calibratedRed: 1, green: 0.98, blue: 0.91, alpha: 1).setFill(); paper.fill()
    NSColor(calibratedRed: 0.99, green: 0.76, blue: 0.29, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 293, y: 473, width: 392, height: 75), xRadius: 18, yRadius: 18).fill()
    NSColor(calibratedRed: 0.16, green: 0.26, blue: 0.47, alpha: 1).setFill()
    for (y, width) in [(675.0, 330.0), (570.0, 372.0), (385.0, 312.0), (280.0, 215.0)] {
        NSBezierPath(roundedRect: NSRect(x: 309, y: y, width: width, height: 28), xRadius: 14, yRadius: 14).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(file))
}
for size in [16, 32, 128, 256, 512] {
    try draw(size, "icon_\(size)x\(size).png")
    try draw(size * 2, "icon_\(size)x\(size)@2x.png")
}
