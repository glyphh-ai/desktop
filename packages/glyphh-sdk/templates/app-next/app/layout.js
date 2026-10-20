export const metadata = { title: "Notes" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#1a1a1c", color: "#f1f1f1", fontFamily: "Geist, -apple-system, system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
