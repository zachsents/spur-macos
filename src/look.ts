// What this Mac looks like, for its picture in the vitals widget, told by its hardware. An Apple
// silicon Mac carries its product name ("MacBook Air (15-inch, M4, 2025)", "Mac mini (2024)"); an
// Intel one only its model identifier ("MacBookPro16,1"). A Mac neither names as one that's drawn
// is a laptop if it has a battery, else the Mac mini. Sizes are Apple's published ones.

export interface Look {
  /** A laptop, open; the Mac mini as it's been since 2024, or as it was from 2010; the Mac Studio. */
  readonly form: "laptop" | "mini" | "mini-2010" | "studio"
  /** Width, depth and height, closed, mm. */
  readonly mm: readonly [number, number, number]
  /** Its display has the camera notch (MacBook Pro from 2021, MacBook Air from 2022). */
  readonly notch?: boolean
  /** Its keys sit in a black well (MacBook Pro from 2021). */
  readonly well?: boolean
}

const run = async (argv: readonly string[]) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}

const MINI: Look = { form: "mini", mm: [127, 127, 50] }
const AIR: Look = { form: "laptop", mm: [304.1, 215, 11.3], notch: true }

/** A MacBook Pro by its screen and year: from 2021 its 14- and 16-inch ones have the notch and
 * the black well. */
const pro = (inches: number, year: number): Look => {
  if (year >= 2021 && (inches === 14 || inches === 16)) {
    return {
      form: "laptop",
      mm: inches === 14 ? [312.6, 221.2, 15.5] : [355.7, 248.1, 16.8],
      notch: true,
      well: true,
    }
  }
  if (inches === 16) {
    return { form: "laptop", mm: [357.9, 245.9, 16.2] }
  }
  return { form: "laptop", mm: inches === 15 ? [349.3, 240.7, 15.5] : [304.1, 212.4, 15.6] }
}

/** What a Mac by this name looks like; `laptop` decides when the name says nothing. */
export const lookOf = (name: string, laptop: boolean): Look => {
  const plain = name.toLowerCase().replaceAll(" ", "")
  const year = Number(/\b(?<year>20\d\d)\b/u.exec(name)?.groups?.year ?? 0)
  const inches = Number(/(?<inches>\d+)-inch/u.exec(name)?.groups?.inches ?? 0)
  if (plain.startsWith("macbookair")) {
    return {
      form: "laptop",
      mm: inches === 15 ? [340.4, 237.6, 11.5] : [304.1, 215, 11.3],
      notch: year >= 2022,
    }
  }
  if (plain.startsWith("macbookpro")) {
    return pro(inches, year)
  }
  if (plain.startsWith("macbook")) {
    return { form: "laptop", mm: [280.5, 196.5, 13.1] }
  }
  if (plain.startsWith("macmini")) {
    return year >= 2024 ? MINI : { form: "mini-2010", mm: [197, 197, 36] }
  }
  if (plain.startsWith("macstudio")) {
    return { form: "studio", mm: [197, 197, 95] }
  }
  return laptop ? AIR : MINI
}

/** This Mac's look, from its hardware. */
export const look = async (): Promise<Look> => {
  const [product, model, battery] = await Promise.all([
    run(["ioreg", "-rd1", "-k", "product-name"]),
    run(["sysctl", "-n", "hw.model"]),
    run(["pmset", "-g", "batt"]),
  ])
  const name = /"product-name" = <"(?<name>[^"]+)">/u.exec(product)?.groups?.name ?? model.trim()
  return lookOf(name, battery.includes("InternalBattery"))
}
