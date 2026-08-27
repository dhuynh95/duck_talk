import SwiftUI

/// Placeholder screen. Enough to prove the build/run/screenshot loop works —
/// the real UI lands on top of this.
struct ContentView: View {
    @State private var quacks = 0

    var body: some View {
        VStack(spacing: 24) {
            Text("🦆")
                .font(.system(size: 72))

            Text("Duck Talk")
                .font(.largeTitle.weight(.semibold))

            Text(quacks == 0 ? "Tap to check the loop" : "Quacks: \(quacks)")
                .foregroundStyle(.secondary)
                .contentTransition(.numericText())

            Button("Quack") {
                withAnimation { quacks += 1 }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
