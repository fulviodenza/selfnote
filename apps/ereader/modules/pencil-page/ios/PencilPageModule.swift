import ExpoModulesCore
import PencilKit

public class PencilPageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PencilPage")

    View(PencilPageView.self) {
      Events("onChange")

      Prop("drawing") { (view: PencilPageView, data: String?) in
        view.setDrawing(data)
      }

      Prop("vectors") { (view: PencilPageView, json: String?) in
        view.setVectors(json)
      }
    }
  }
}

class PencilPageView: ExpoView, PKCanvasViewDelegate {
  let canvas = PKCanvasView()
  let onChange = EventDispatcher()

  private var toolPicker: PKToolPicker?
  // Loading a drawing fires canvasViewDrawingDidChange like a pen stroke does;
  // without this flag every load would immediately echo itself back as a save.
  private var applying = false
  private var pendingEmit: DispatchWorkItem?
  // Vector import scales to the canvas box, which is zero until layout, so
  // the data waits here for the first real layout pass.
  private var pendingDrawing: String?
  private var pendingVectors: String?
  // The props are starting content. Once the user has drawn, the canvas is
  // the only owner of the ink: React re-delivers props on every render, and
  // reloading on a re-delivery wiped whatever was written since the last
  // save, while a reload landing mid-stroke cancelled the stroke outright.
  // Fast handwriting lost characters both ways. A plain load-once latch is
  // not the answer either: layout can run before the initial props arrive,
  // and latching on that empty pass left stored ink permanently unloaded.
  private var hasUserInk = false
  private var loadedKey: String?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    canvas.delegate = self
    canvas.backgroundColor = .clear
    canvas.isOpaque = false
    // The paper behind this view is the page; the canvas is only the ink.
    // PKCanvasView is a scroll view, but the page never pans or zooms.
    canvas.isScrollEnabled = false
    canvas.minimumZoomScale = 1
    canvas.maximumZoomScale = 1
    // .default draws with the Pencil and lets a finger follow the user's own
    // iPadOS "Draw with Finger" setting, which is also what keeps the feature
    // usable on an iPad without a Pencil and on the simulator.
    canvas.drawingPolicy = .default
    addSubview(canvas)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    canvas.frame = bounds
    applyPendingIfReady()
  }

  override func willMove(toSuperview newSuperview: UIView?) {
    // Leaving the page must not lose the last strokes to the debounce.
    if newSuperview == nil, pendingEmit != nil {
      pendingEmit?.cancel()
      pendingEmit = nil
      emit()
    }
    super.willMove(toSuperview: newSuperview)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else {
      toolPicker?.setVisible(false, forFirstResponder: canvas)
      toolPicker?.removeObserver(canvas)
      toolPicker = nil
      return
    }
    let picker = PKToolPicker()
    picker.setVisible(true, forFirstResponder: canvas)
    picker.addObserver(canvas)
    toolPicker = picker
    canvas.becomeFirstResponder()
  }

  func setDrawing(_ base64: String?) {
    pendingDrawing = base64
    applyPendingIfReady()
  }

  func setVectors(_ json: String?) {
    pendingVectors = json
    applyPendingIfReady()
  }

  private func applyPendingIfReady() {
    guard bounds.width > 0, bounds.height > 0 else { return }
    let key = (pendingDrawing ?? "") + "|" + (pendingVectors ?? "")
    guard key != loadedKey else { return }
    loadedKey = key
    var loaded = PKDrawing()
    if let base64 = pendingDrawing, let data = Data(base64Encoded: base64),
      let drawing = try? PKDrawing(data: data)
    {
      loaded = drawing
    } else if let json = pendingVectors {
      loaded = Self.drawingFromVectors(json, in: bounds.size)
    }
    applying = true
    defer { applying = false }
    if hasUserInk {
      // Stored ink arriving after the pen already touched down lands under
      // what was written, instead of replacing it.
      canvas.drawing = PKDrawing(strokes: loaded.strokes + canvas.drawing.strokes)
    } else {
      canvas.drawing = loaded
    }
  }

  func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
    guard !applying else { return }
    hasUserInk = true
    pendingEmit?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.emit() }
    pendingEmit = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
  }

  private func emit() {
    let drawing = canvas.drawing
    onChange([
      "pk": drawing.dataRepresentation().base64EncodedString(),
      "v": exportVectors(drawing),
    ])
  }

  /// The same ink as normalised vectors in the web canvas's stroke format, so
  /// platforms without PencilKit can still display the page.
  private func exportVectors(_ drawing: PKDrawing) -> String {
    let size = canvas.bounds.size
    guard size.width > 0, size.height > 0 else { return "[]" }
    var out: [[String: Any]] = []
    for stroke in drawing.strokes {
      var maxWidth: CGFloat = 0.5
      for point in stroke.path {
        maxWidth = max(maxWidth, point.size.width)
      }
      // The web renderer paints at w * (0.4 + pressure); solve for a base
      // width and per-point pressure that reproduce PencilKit's point sizes.
      let base = maxWidth / 1.4
      var points: [[Double]] = []
      for point in stroke.path {
        let location = point.location.applying(stroke.transform)
        let pressure = min(1, max(0.05, point.size.width / base - 0.4))
        points.append([
          round4(location.x / size.width),
          round4(location.y / size.height),
          round4(pressure),
        ])
      }
      out.append([
        "c": Self.hexString(stroke.ink.color),
        "w": round4(base),
        "p": points,
      ])
    }
    guard let data = try? JSONSerialization.data(withJSONObject: out),
      let json = String(data: data, encoding: .utf8)
    else { return "[]" }
    return json
  }

  /// Strokes written by the web canvas before the surface went native, raised
  /// into PKStrokes so nothing already on a page is lost.
  private static func drawingFromVectors(_ json: String, in size: CGSize) -> PKDrawing {
    guard size.width > 0, size.height > 0,
      let data = json.data(using: .utf8),
      let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { return PKDrawing() }
    var strokes: [PKStroke] = []
    for raw in parsed {
      guard let pts = raw["p"] as? [[Double]], !pts.isEmpty else { continue }
      let base = CGFloat((raw["w"] as? Double) ?? 3.2)
      let color = colorFromHex((raw["c"] as? String) ?? "#1b2a3a")
      var controlPoints: [PKStrokePoint] = []
      var time: TimeInterval = 0
      for p in pts {
        let pressure = CGFloat(p.count > 2 ? p[2] : 0.5)
        let width = base * (0.4 + pressure)
        controlPoints.append(
          PKStrokePoint(
            location: CGPoint(x: CGFloat(p[0]) * size.width, y: CGFloat(p[1]) * size.height),
            timeOffset: time,
            size: CGSize(width: width, height: width),
            opacity: 1,
            force: pressure,
            azimuth: 0,
            altitude: .pi / 2
          ))
        time += 0.008
      }
      strokes.append(
        PKStroke(
          ink: PKInk(.pen, color: color),
          path: PKStrokePath(controlPoints: controlPoints, creationDate: Date())
        ))
    }
    return PKDrawing(strokes: strokes)
  }

  private func round4(_ value: CGFloat) -> Double {
    (Double(value) * 10000).rounded() / 10000
  }

  private static func hexString(_ color: UIColor) -> String {
    var r: CGFloat = 0
    var g: CGFloat = 0
    var b: CGFloat = 0
    var a: CGFloat = 0
    color.getRed(&r, green: &g, blue: &b, alpha: &a)
    return String(
      format: "#%02x%02x%02x",
      Int(round(r * 255)), Int(round(g * 255)), Int(round(b * 255)))
  }

  private static func colorFromHex(_ hex: String) -> UIColor {
    var value: UInt64 = 0
    let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard Scanner(string: cleaned).scanHexInt64(&value), cleaned.count == 6 else {
      return UIColor(red: 0.11, green: 0.16, blue: 0.23, alpha: 1)
    }
    return UIColor(
      red: CGFloat((value >> 16) & 0xff) / 255,
      green: CGFloat((value >> 8) & 0xff) / 255,
      blue: CGFloat(value & 0xff) / 255,
      alpha: 1)
  }
}
