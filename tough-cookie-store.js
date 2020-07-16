const fs = require('fs')
const tough = require('tough-cookie')

const readCookieFile = filePath => {
  try {
    const json = fs.readFileSync(filePath)
    const data = json ? JSON.parse(json) : {}
    for (const [domainName, domainData] of Object.entries(data)) {
      for (const [pathName, pathData] of Object.entries(domainData)) {
        for (const [cookieName, cookieData] of Object.entries(pathData)) {
          data[domainName][pathName][cookieName] = tough.Cookie.fromJSON(cookieData)
        }
      }
    }
    return data
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {}
    }
    throw err
  }
}

const saveCookieFile = (filePath, data, cb) => {
  fs.writeFile(filePath, JSON.stringify(data), cb)
}

module.exports = class FileCookieStore extends tough.MemoryCookieStore {
  constructor (filePath) {
    super()
    this.filePath = filePath
    // Working with it synchronously should be just fine so I commented this out
    // this.synchronous = false;
    this.idx = readCookieFile(filePath)
  }

  saveToFile (cb) {
    saveCookieFile(this.filePath, this.idx, cb)
  }

  putCookie (cookie, cb) {
    super.putCookie(cookie, () => this.saveToFile(cb))
  }

  removeCookie (domain, path, key, cb) {
    super.removeCookie(domain, path, key, () => this.saveToFile(cb))
  }

  removeCookies (domain, path, cb) {
    super.removeCookies(domain, path, () => this.saveToFile(cb))
  }

  updateCookie (oldCookie, newCookie, cb) {
    super.updateCookie(oldCookie, newCookie, () => this.saveToFile(cb))
  }
}
