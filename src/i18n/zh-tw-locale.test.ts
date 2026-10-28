import { afterEach, describe, expect, it } from "vitest"
import i18n from "./index"

describe("zh-TW locale", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en")
  })

  it("resolves Traditional Chinese strings for zh-TW", async () => {
    await i18n.changeLanguage("zh-TW")
    expect(i18n.language).toBe("zh-TW")
    expect(i18n.t("settings.title")).toBe("設定")
    expect(i18n.t("sources.importFolder")).toBe("資料夾")
  })

  it("keeps zh on the Simplified Chinese bundle", async () => {
    await i18n.changeLanguage("zh")
    expect(i18n.t("settings.title")).toBe("设置")
  })
})
