// orcad2json: read an OrCAD Capture .DSN/.OLB file and print its content as JSON.
//
//   orcad2json <file> [--raw] [--verbose]
//
// stdout: one JSON document (only when the run succeeded).
// stderr: logs and error messages.
//
// Exit codes
//   0  ok (see "warnings" in the JSON for anything that was only partly understood)
//   1  usage error
//   2  input is not a usable CFBF container (missing, not CFBF, truncated)
//   3  the container opened, but it holds nothing the tool can read as OrCAD data
//   4  the parser crashed or ran out of time on this input
//
// Built on OpenOrCadParser (MIT), linked without changing its sources.
//
// Why this file reads some records itself instead of using StreamPage alone:
// the parser reads several things it then throws away because they are local
// variables in read(), or skips as "unknown" bytes:
//   StructPlacedInstance  package name, position, reference, source package,
//                         and in its unknown bytes: value, rotation, mirror,
//                         section (decoded here, see readPlacedInstance)
//   StructT0x10           pin order, pin hot point, id of the wire on that pin
//   StreamPage            net name -> net id table
//   StructWire            the wire's own id (the one pins refer to)
//   StructGraphicInst     index of the connector's real name in the string table
//   read_single_prefix_short  the property (name, value) index pairs
//   StreamCache           every symbol and package it reads
//   StructDevice          positions of pins without a number
//   StructSymbolPin       the pin's properties (PSpiceDefaultNet)
//   DrawnInstance         hierarchical block: the parser has no class for it
//   Library version 2.x   the old format: the parser cannot read its records
// The readers below follow exactly the same byte layout as those read()
// functions and keep the values. All other records still go through the
// parser's own classes.
//
// Parser defects worked around here (reported, not patched):
//   StreamLibrary::read() predicts the version by reading repeatedly into the
//   same object, so strLst holds junk + one list per attempt and every index
//   into it is shifted. We read the Library stream with a fixed version into a
//   fresh object, so indexes are correct.
//   ContainerContext writes logs/OpenOrCadParser.log relative to the current
//   directory, and the default spdlog logger prints to stdout. We run in a
//   private temporary directory and replace the default logger.

#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <fmt/core.h>
#include <spdlog/sinks/base_sink.h>
#include <spdlog/spdlog.h>

#ifndef COMPOUNDFILEREADER_H
#define COMPOUNDFILEREADER_H
#include <compoundfilereader.h>
#endif
#include <utf.h>

#include "Container.hpp"
#include "ContainerContext.hpp"
#include "Enums/PortType.hpp"
#include "Enums/Structure.hpp"
#include "FutureData.hpp"
#include "General.hpp"
#include "GenericParser.hpp"
#include "PageSettings.hpp"
#include "Record.hpp"
#include "Stream.hpp"
#include "StreamContext.hpp"
#include "StreamFactory.hpp"
#include "Streams/StreamLibrary.hpp"
#include "Streams/StreamPackage.hpp"
#include "Streams/StreamSymbol.hpp"
#include "Win32/LOGFONTA.hpp"
#include "Structures/StructAlias.hpp"
#include "Structures/StructBusEntry.hpp"
#include "Structures/StructDevice.hpp"
#include "Structures/StructGlobal.hpp"
#include "Structures/StructGeneralProperties.hpp"
#include "Structures/StructGlobalSymbol.hpp"
#include "Structures/StructGraphicInst.hpp"
#include "Structures/StructLibraryPart.hpp"
#include "Structures/StructOffPageConnector.hpp"
#include "Structures/StructOffPageSymbol.hpp"
#include "Structures/StructPackage.hpp"
#include "Structures/StructPartCell.hpp"
#include "Structures/StructPlacedInstance.hpp"
#include "Structures/StructPort.hpp"
#include "Structures/StructPortSymbol.hpp"
#include "Structures/StructSymbolDisplayProp.hpp"
#include "Structures/StructSymbolPin.hpp"
#include "Structures/StructT0x34.hpp"
#include "Structures/StructT0x35.hpp"
#include "Structures/StructTitleBlock.hpp"
#include "Structures/StructWire.hpp"

namespace fs = std::filesystem;
using namespace OOCP;

namespace
{
// ---------------------------------------------------------------------------
// exit codes and error type
// ---------------------------------------------------------------------------
enum ExitCode
{
    EXIT_OK        = 0,
    EXIT_USAGE     = 1,
    EXIT_BAD_INPUT = 2,
    EXIT_NO_DATA   = 3,
    EXIT_CRASH     = 4
};

struct InputError : std::runtime_error
{
    int code;
    InputError(int aCode, const std::string& aMsg)
        : std::runtime_error{aMsg},
          code{aCode}
    {
    }
};

bool gVerbose = false;
bool gRaw     = false;

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

// OrCAD stores text in the Windows ANSI code page. Keep valid UTF-8 as it is,
// map everything else byte by byte as CP1252 so "10uF" with a micro sign and
// similar stay readable and the JSON stays valid.
std::string toUtf8(const std::string& aIn)
{
    static const char32_t cp1252hi[32] = {0x20AC, 0x81, 0x201A, 0x192, 0x201E, 0x2026, 0x2020, 0x2021, 0x2C6, 0x2030,
        0x160, 0x2039, 0x152, 0x8D, 0x17D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x2DC,
        0x2122, 0x161, 0x203A, 0x153, 0x9D, 0x17E, 0x178};

    const auto isValidUtf8 = [](const std::string& s) -> bool
    {
        for(size_t i = 0; i < s.size();)
        {
            const unsigned char c = static_cast<unsigned char>(s[i]);
            size_t extra          = 0;
            if(c < 0x80)
                extra = 0;
            else if(c >= 0xC2 && c <= 0xDF)
                extra = 1;
            else if(c >= 0xE0 && c <= 0xEF)
                extra = 2;
            else if(c >= 0xF0 && c <= 0xF4)
                extra = 3;
            else
                return false;
            if(i + extra >= s.size() + (extra == 0 ? 1 : 0))
                return false;
            for(size_t j = 1; j <= extra; ++j)
            {
                if((static_cast<unsigned char>(s[i + j]) & 0xC0) != 0x80)
                    return false;
            }
            i += extra + 1;
        }
        return true;
    };

    if(isValidUtf8(aIn))
        return aIn;

    std::string out;
    for(unsigned char c : aIn)
    {
        char32_t cp = c;
        if(c >= 0x80 && c <= 0x9F)
            cp = cp1252hi[c - 0x80];
        if(cp < 0x80)
        {
            out += static_cast<char>(cp);
        }
        else if(cp < 0x800)
        {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
        else
        {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }
    return out;
}

std::string jstr(const std::string& aIn)
{
    const std::string s = toUtf8(aIn);
    std::string out     = "\"";
    for(unsigned char c : s)
    {
        switch(c)
        {
            case '"':
                out += "\\\"";
                break;
            case '\\':
                out += "\\\\";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                if(c < 0x20)
                    out += fmt::format("\\u{:04x}", c);
                else
                    out += static_cast<char>(c);
        }
    }
    out += "\"";
    return out;
}

template <typename T, typename F> std::string jarr(const std::vector<T>& aItems, F aFn)
{
    std::string out = "[";
    bool first      = true;
    for(const auto& item : aItems)
    {
        if(!first)
            out += ",";
        first = false;
        out += aFn(item);
    }
    out += "]";
    return out;
}

std::string hexBytes(const std::vector<uint8_t>& aData)
{
    std::string out;
    for(uint8_t b : aData)
        out += fmt::format("{:02x}", b);
    return out;
}

// ---------------------------------------------------------------------------
// warnings
// ---------------------------------------------------------------------------
class Warnings
{
public:
    void add(const std::string& aMsg)
    {
        if(mSeen.insert(aMsg).second)
            mList.push_back(aMsg);
    }

    const std::vector<std::string>& list() const
    {
        return mList;
    }

private:
    std::vector<std::string> mList;
    std::set<std::string> mSeen;
};

Warnings gWarnings;

// Default spdlog logger: the parser reports a few container problems with
// spdlog::error(). Keep them for "warnings", and never touch stdout.
class CollectSink : public spdlog::sinks::base_sink<std::mutex>
{
protected:
    void sink_it_(const spdlog::details::log_msg& aMsg) override
    {
        const std::string text(aMsg.payload.data(), aMsg.payload.size());
        if(aMsg.level >= spdlog::level::warn)
            gWarnings.add(fmt::format("parser: {}", text));
        if(gVerbose)
            std::cerr << "[parser] " << text << "\n";
    }

    void flush_() override
    {
    }
};

// ---------------------------------------------------------------------------
// CFBF sanity check. CFB::CompoundFileReader reads through the sector chain
// without checking all bounds, so a truncated file must be stopped before it.
// ---------------------------------------------------------------------------
uint32_t le32(const std::vector<uint8_t>& aBuf, size_t aOff)
{
    return static_cast<uint32_t>(aBuf[aOff]) | (static_cast<uint32_t>(aBuf[aOff + 1]) << 8) |
           (static_cast<uint32_t>(aBuf[aOff + 2]) << 16) | (static_cast<uint32_t>(aBuf[aOff + 3]) << 24);
}

uint16_t le16(const std::vector<uint8_t>& aBuf, size_t aOff)
{
    return static_cast<uint16_t>(aBuf[aOff] | (aBuf[aOff + 1] << 8));
}

void checkCfbf(const fs::path& aFile)
{
    std::ifstream in{aFile, std::ios::binary};
    if(!in)
        throw InputError{EXIT_BAD_INPUT, "cannot read the file"};

    std::vector<uint8_t> buf{std::istreambuf_iterator<char>{in}, std::istreambuf_iterator<char>{}};

    const std::vector<uint8_t> magic{0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1};
    if(buf.size() < 512 || !std::equal(magic.begin(), magic.end(), buf.begin()))
    {
        throw InputError{EXIT_BAD_INPUT,
            fmt::format("not an OrCAD file: no CFBF (Compound File) signature in {} bytes. Note that OrCAD files before "
                        "9.x and text exports are not CFBF containers and cannot be read",
                buf.size())};
    }

    const uint16_t shift = le16(buf, 30);
    if(shift != 9 && shift != 12)
        throw InputError{EXIT_BAD_INPUT, fmt::format("corrupt CFBF header: sector shift {}", shift)};

    const size_t sectorSize = size_t{1} << shift;
    const size_t numFat     = le32(buf, 44);
    const size_t maxSectors = buf.size() >= sectorSize ? (buf.size() - sectorSize) / sectorSize : 0;

    const auto sectorInFile = [&](uint32_t aSect) { return static_cast<size_t>(aSect) < maxSectors; };
    const auto truncated    = [&](uint32_t aSect)
    {
        return InputError{EXIT_BAD_INPUT,
            fmt::format("truncated file: the container needs sector {} (at least {} bytes) but the file has {} bytes",
                aSect, (static_cast<size_t>(aSect) + 2) * sectorSize, buf.size())};
    };

    // Gather FAT sector numbers from the header and from the DIFAT chain.
    std::vector<uint32_t> fatSectors;
    for(size_t i = 0; i < 109 && fatSectors.size() < numFat; ++i)
    {
        const uint32_t s = le32(buf, 76 + i * 4);
        if(s < 0xFFFFFFFA)
            fatSectors.push_back(s);
    }

    uint32_t difat       = le32(buf, 68);
    size_t difatGuard    = 0;
    const size_t perSect = sectorSize / 4;
    while(difat < 0xFFFFFFFA && fatSectors.size() < numFat)
    {
        if(++difatGuard > maxSectors + 1)
            throw InputError{EXIT_BAD_INPUT, "corrupt CFBF: DIFAT chain does not end"};
        if(!sectorInFile(difat))
            throw truncated(difat);
        const size_t base = (static_cast<size_t>(difat) + 1) * sectorSize;
        for(size_t i = 0; i + 1 < perSect && fatSectors.size() < numFat; ++i)
        {
            const uint32_t s = le32(buf, base + i * 4);
            if(s < 0xFFFFFFFA)
                fatSectors.push_back(s);
        }
        difat = le32(buf, base + (perSect - 1) * 4);
    }

    if(fatSectors.size() < numFat)
    {
        throw InputError{
            EXIT_BAD_INPUT, fmt::format("corrupt CFBF: {} FAT sectors declared, {} found", numFat, fatSectors.size())};
    }

    // Every used sector must lie inside the file.
    for(uint32_t fs_ : fatSectors)
    {
        if(!sectorInFile(fs_))
            throw truncated(fs_);
    }

    size_t sectorIdx = 0;
    for(uint32_t fs_ : fatSectors)
    {
        const size_t base = (static_cast<size_t>(fs_) + 1) * sectorSize;
        for(size_t i = 0; i < perSect; ++i, ++sectorIdx)
        {
            const uint32_t next = le32(buf, base + i * 4);
            if(next == 0xFFFFFFFF) // FREESECT
                continue;
            if(next < 0xFFFFFFFA && !sectorInFile(next))
                throw truncated(next);
            if(sectorIdx >= maxSectors)
                throw truncated(static_cast<uint32_t>(sectorIdx));
        }
    }

    const uint32_t firstDir = le32(buf, 48);
    if(!sectorInFile(firstDir))
        throw truncated(firstDir);
}

// ---------------------------------------------------------------------------
// ContainerExtractor names its output with replace_extension(".bin"), so
// "AMS1117-3.3" and "AMS1117-3.3V" land in one file and one part is lost. Write
// those streams again under their full names; everything else stays as it is.
// ---------------------------------------------------------------------------
void rescueCollidedStreams(const fs::path& aFile, const fs::path& aRoot)
{
    std::ifstream in{aFile, std::ios::binary};
    std::vector<uint8_t> buf{std::istreambuf_iterator<char>{in}, std::istreambuf_iterator<char>{}};
    CFB::CompoundFileReader reader{buf.data(), buf.size()};

    std::map<std::string, std::vector<std::pair<fs::path, const CFB::COMPOUND_FILE_ENTRY*>>> byTarget;

    reader.EnumFiles(reader.GetRootEntry(), -1,
        [&](const CFB::COMPOUND_FILE_ENTRY* aEntry, const CFB::utf16string& aDir, int /* level */)
        {
            if(!reader.IsStream(aEntry))
                return;

            // CFB joins directory levels as <name> NUL \n <name> NUL.
            fs::path dir;
            CFB::utf16string level;
            for(const auto ch : aDir)
            {
                if(ch == 0)
                    continue;
                if(ch == '\n')
                {
                    dir /= UTF16ToUTF8(level.c_str());
                    level.clear();
                }
                else
                    level += ch;
            }
            if(!level.empty())
                dir /= UTF16ToUTF8(level.c_str());

            const fs::path rel = dir / fs::path{UTF16ToUTF8(aEntry->name)};
            byTarget[fs::path{rel}.replace_extension(".bin").generic_string()].push_back({rel, aEntry});
        });

    for(const auto& [target, streams] : byTarget)
    {
        if(streams.size() < 2)
            continue;

        fs::remove(aRoot / target);
        for(const auto& [rel, entry] : streams)
        {
            std::vector<char> content(static_cast<size_t>(entry->size));
            reader.ReadFile(entry, 0, content.data(), content.size());

            fs::path out = aRoot / rel;
            out += ".bin";
            fs::create_directories(out.parent_path());
            std::ofstream file{out, std::ios::binary};
            file.write(content.data(), static_cast<std::streamsize>(content.size()));
            if(!file)
                throw std::runtime_error("cannot write the extracted stream " + out.string());
        }
    }
}

// ---------------------------------------------------------------------------
// Own readers for what the parser reads and drops
// ---------------------------------------------------------------------------
using PropPairs = std::vector<std::pair<uint32_t, uint32_t>>;

// auto_read_prefixes() walks over the prefixes and discards the property pairs
// of the last, short prefix. Walk that one prefix again and keep them.
Structure readPrefixes(StreamContext& aCtx, GenericParser& aParser, FutureDataLst& aFuture, PropPairs* aProps)
{
    auto& ds                = aCtx.mDs;
    const size_t start      = ds.getCurrentOffset();
    const Structure type    = aParser.auto_read_prefixes(aFuture);
    const size_t afterwards = ds.getCurrentOffset();

    if(aProps != nullptr)
    {
        // Long prefixes are 9 bytes, one per FutureData entry pushed above.
        ds.setCurrentOffset(start + aFuture.size() * 9U);
        ds.readUint8();
        const int16_t count = ds.readInt16();
        for(int i = 0; i < count; ++i)
        {
            const uint32_t nameIdx  = ds.readUint32();
            const uint32_t valueIdx = ds.readUint32();
            aProps->push_back({nameIdx, valueIdx});
        }
        if(ds.getCurrentOffset() != afterwards)
        {
            throw std::runtime_error(
                fmt::format("property prefix ended at 0x{:x}, expected 0x{:x}", ds.getCurrentOffset(), afterwards));
        }
    }

    return type;
}

struct PinRec
{
    uint16_t order = 0;
    int16_t x      = 0;
    int16_t y      = 0;
    uint32_t id    = 0;
    uint32_t unk   = 0;
};

struct InstRec
{
    std::string pkgName;
    std::string ref;
    std::string sourcePkg;
    uint32_t dbId     = 0;
    int16_t x         = 0;
    int16_t y         = 0;
    uint32_t valueIdx = 0;
    uint32_t implPathIdx = 0;
    uint32_t implNameIdx = 0;
    uint16_t implType    = 0;
    bool block           = false; // hierarchical block drawn on the page
    std::vector<std::string> blockPins;
    uint16_t section  = 0;
    uint8_t rotation  = 0;
    bool mirror       = false;
    int16_t bx1 = 0, by1 = 0, bx2 = 0, by2 = 0;
    PropPairs props;
    std::vector<PinRec> pins;
    std::vector<uint8_t> u0, u1, u2, u3, u4, u5;
};

struct AliasRec
{
    std::string name;
    int32_t x = 0;
    int32_t y = 0;
};

struct WireRec
{
    bool bus      = false;
    uint32_t dbId = 0;
    uint32_t net  = 0;
    int32_t x1 = 0, y1 = 0, x2 = 0, y2 = 0;
    std::vector<AliasRec> aliases;
    PropPairs props;
};

struct ConnRec // Global, Port, OffPageConnector
{
    std::string symbol;   // name of the drawn symbol, for example "OFFPAGE Out PinL"
    uint32_t nameIdx = 0; // index of the connector's own name in the string table
    uint32_t dbId    = 0;
    int16_t x        = 0;
    int16_t y        = 0;
    int16_t x1 = 0, y1 = 0, x2 = 0, y2 = 0;
    PropPairs props;
    std::vector<uint8_t> raw3, raw5;
    uint8_t rotation = 0; // same encoding as a placed instance: bits 0-1 turn, bit 2 mirror
    bool hasHot      = false;
    int hotX = 0, hotY = 0; // the connection point, filled in by computeHotPoints()
};

struct BusEntryRec
{
    int32_t x1 = 0, y1 = 0, x2 = 0, y2 = 0;
};

struct PageRec
{
    std::string view;
    std::string name;
    std::string pageSize;
    std::vector<std::pair<std::string, uint32_t>> netMap;
    std::vector<uint32_t> pageNetIds; // T0x34 ids
    std::vector<WireRec> wires;
    std::vector<InstRec> instances;
    std::vector<ConnRec> globals, ports, offPage;
    std::vector<BusEntryRec> busEntries;
    std::vector<std::string> titleBlocks;
    size_t graphics = 0;
    size_t unread   = 0;
};

// Read one record through the parser, without its "skip silently" handling:
// a failure becomes a warning and the record is skipped by its length prefix.
std::unique_ptr<Record> readRecord(StreamContext& aCtx, GenericParser& aParser, const std::string& aWhere, size_t& aUnread)
{
    auto& ds           = aCtx.mDs;
    const size_t start = ds.getCurrentOffset();

    try
    {
        return aParser.readStructure();
    }
    catch(const std::exception& e)
    {
        gWarnings.add(fmt::format("{}: record at 0x{:x} could not be read and was skipped: {}", aWhere, start, e.what()));
        ++aUnread;
        ds.clear();
        ds.setCurrentOffset(start);
        FutureDataLst future{aCtx};
        aParser.auto_read_prefixes(future);
        future.readRestOfStructure();
        return nullptr;
    }
}

// The second half of a placed part and of a hierarchical block: same layout.
void readInstanceTail(StreamContext& aCtx, GenericParser& aParser, FutureDataLst& aFuture, InstRec& aInst, const std::string& aWhere,
    size_t& aUnread)
{
    auto& ds = aCtx.mDs;

    aInst.ref = ds.readStringLenZeroTerm();
    aInst.u4  = ds.readBytes(14);

    // String table indexes the parser leaves as unknown: the Value property,
    // and the Implementation Path and Implementation properties.
    aInst.valueIdx    = le32(aInst.u4, 0);
    aInst.implPathIdx = le32(aInst.u4, 4);
    aInst.implNameIdx = le32(aInst.u4, 8);
    aInst.implType    = le16(aInst.u4, 12);

    const uint16_t lenPins = ds.readUint16();
    for(size_t i = 0; i < lenPins; ++i)
    {
        FutureDataLst pinFuture{aCtx};
        const Structure pinType = readPrefixes(aCtx, aParser, pinFuture, nullptr);
        if(pinType != Structure::T0x10)
            throw std::runtime_error(fmt::format("expected T0x10, got {}", OOCP::to_string(pinType)));

        aParser.readPreamble();
        pinFuture.checkpoint();

        PinRec pin;
        pin.order = ds.readUint16();
        pin.x     = ds.readInt16();
        pin.y     = ds.readInt16();
        pin.id    = ds.readUint32();
        pin.unk   = ds.readUint32();

        const uint16_t lenPinProps = ds.readUint16();
        for(size_t j = 0; j < lenPinProps; ++j)
            readRecord(aCtx, aParser, aWhere, aUnread);

        pinFuture.checkpoint();
        pinFuture.sanitizeCheckpoints();

        aInst.pins.push_back(pin);
    }

    aFuture.checkpoint();

    if(aInst.block)
    {
        aFuture.sanitizeCheckpoints();
        return; // a block has no package: the record ends here
    }

    aInst.sourcePkg = ds.readStringLenZeroTerm();
    aInst.u5        = ds.readBytes(2);
    aInst.section   = le16(aInst.u5, 0); // index into the package's devices

    aFuture.checkpoint();
    aFuture.sanitizeCheckpoints();
}

InstRec readPlacedInstance(StreamContext& aCtx, GenericParser& aParser, const std::string& aWhere, size_t& aUnread)
{
    auto& ds = aCtx.mDs;

    InstRec inst;
    FutureDataLst future{aCtx};

    const Structure type = readPrefixes(aCtx, aParser, future, &inst.props);
    if(type != Structure::PlacedInstance)
        throw std::runtime_error(fmt::format("expected PlacedInstance, got {}", OOCP::to_string(type)));

    aParser.readPreamble();
    future.checkpoint();

    inst.u0      = ds.readBytes(8);
    inst.pkgName = ds.readStringLenZeroTerm();
    inst.dbId    = ds.readUint32();
    inst.u1      = ds.readBytes(8);
    inst.x       = ds.readInt16();
    inst.y       = ds.readInt16();
    inst.u2      = ds.readBytes(4);

    // Bytes the parser leaves as unknown. Checked on two real designs: the
    // bounding box holds every pin, and rotation/mirror reproduce the pin
    // layout of the symbol (see test/evidence.md).
    const auto s16 = [](const std::vector<uint8_t>& b, size_t o)
    { return static_cast<int16_t>(static_cast<uint16_t>(b[o] | (b[o + 1] << 8))); };
    inst.by1      = s16(inst.u1, 0);
    inst.bx1      = s16(inst.u1, 2);
    inst.by2      = s16(inst.u1, 4);
    inst.bx2      = s16(inst.u1, 6);
    inst.rotation = inst.u2[1] & 0x03;
    inst.mirror   = (inst.u2[1] & 0x04) != 0;

    const uint16_t lenProps = ds.readUint16();
    for(size_t i = 0; i < lenProps; ++i)
        readRecord(aCtx, aParser, aWhere, aUnread);

    inst.u3 = ds.readBytes(1);
    future.checkpoint();

    readInstanceTail(aCtx, aParser, future, inst, aWhere, aUnread);
    return inst;
}

// A hierarchical block (Structure::DrawnInstance). The parser has no class for it
// and skips it. It starts like a placed part, then carries its own symbol, then
// continues exactly like a placed part.
InstRec readDrawnInstance(StreamContext& aCtx, GenericParser& aParser, const std::string& aWhere, size_t& aUnread)
{
    auto& ds = aCtx.mDs;

    InstRec inst;
    inst.block = true;
    FutureDataLst future{aCtx};

    const Structure type = readPrefixes(aCtx, aParser, future, &inst.props);
    if(type != Structure::DrawnInstance)
        throw std::runtime_error(fmt::format("expected DrawnInstance, got {}", OOCP::to_string(type)));

    aParser.readPreamble();
    future.checkpoint();

    inst.u0      = ds.readBytes(8);
    inst.pkgName = ds.readStringLenZeroTerm();
    inst.dbId    = ds.readUint32();
    inst.u1      = ds.readBytes(8);
    inst.x       = ds.readInt16();
    inst.y       = ds.readInt16();
    inst.u2      = ds.readBytes(4);

    const uint16_t lenProps = ds.readUint16();
    for(size_t i = 0; i < lenProps; ++i)
        readRecord(aCtx, aParser, aWhere, aUnread);

    inst.u3 = ds.readBytes(1);

    StructLibraryPart symbol{aCtx};
    symbol.read();
    for(const auto& pin : symbol.symbolPins)
        inst.blockPins.push_back(pin ? pin->name : std::string{});

    future.checkpoint();

    readInstanceTail(aCtx, aParser, future, inst, aWhere, aUnread);
    return inst;
}

WireRec readWire(StreamContext& aCtx, GenericParser& aParser, const std::string& aWhere, size_t& aUnread)
{
    auto& ds = aCtx.mDs;

    WireRec wire;
    FutureDataLst future{aCtx};

    const Structure type = readPrefixes(aCtx, aParser, future, &wire.props);
    if(type != Structure::WireScalar && type != Structure::WireBus)
        throw std::runtime_error(fmt::format("expected a wire, got {}", OOCP::to_string(type)));
    wire.bus = type == Structure::WireBus;

    aParser.readPreamble();
    future.checkpoint();

    wire.dbId = ds.readUint32();
    wire.net  = ds.readUint32();
    ds.readUint32(); // color
    wire.x1 = ds.readInt32();
    wire.y1 = ds.readInt32();
    wire.x2 = ds.readInt32();
    wire.y2 = ds.readInt32();
    ds.readUint8();

    const uint16_t lenAliases = ds.readUint16();
    for(size_t i = 0; i < lenAliases; ++i)
    {
        auto rec = dynamic_pointer_cast<StructAlias>(readRecord(aCtx, aParser, aWhere, aUnread));
        if(rec)
            wire.aliases.push_back({rec->name, rec->locX, rec->locY});
    }

    const uint16_t lenProps = ds.readUint16();
    for(size_t i = 0; i < lenProps; ++i)
        readRecord(aCtx, aParser, aWhere, aUnread);

    ds.readUint32(); // line width
    ds.readUint32(); // line style

    future.checkpoint();
    future.sanitizeCheckpoints();

    return wire;
}

// Same layout as StructGraphicInst::read(), keeping what it drops.
ConnRec readConnector(StreamContext& aCtx, GenericParser& aParser, Structure aExpected, const std::string& aWhere, size_t& aUnread)
{
    auto& ds = aCtx.mDs;

    ConnRec c;
    FutureDataLst future{aCtx};

    const Structure type = readPrefixes(aCtx, aParser, future, &c.props);
    if(type != aExpected)
    {
        throw std::runtime_error(
            fmt::format("expected {}, got {}", OOCP::to_string(aExpected), OOCP::to_string(type)));
    }

    aParser.readPreamble();
    future.checkpoint();

    c.nameIdx = ds.readUint32();
    ds.readUint32(); // string table index of the source library
    c.symbol = ds.readStringLenZeroTerm();
    c.dbId   = ds.readUint32();
    c.y      = ds.readInt16();
    c.x      = ds.readInt16();
    c.y2     = ds.readInt16();
    c.x2     = ds.readInt16();
    c.x1     = ds.readInt16();
    c.y1     = ds.readInt16();
    ds.readUint8(); // color
    c.raw3     = ds.readBytes(3);
    c.rotation = c.raw3[0] & 0x07;

    const uint16_t lenProps = ds.readUint16();
    for(size_t i = 0; i < lenProps; ++i)
        readRecord(aCtx, aParser, aWhere, aUnread);

    const uint8_t flag = ds.readUint8();
    if(flag == 0x02)
        aParser.readStructure();

    future.checkpoint();

    if(aExpected == Structure::Port)
    {
        ds.readBytes(9);
        future.checkpoint();
    }

    future.sanitizeCheckpoints();

    return c;
}

// Same order as StreamPage::read().
PageRec readPage(ContainerContext& aContainerCtx, const fs::path& aPath, const std::string& aView)
{
    StreamContext ctx{aContainerCtx, aPath};
    ctx.mCfg.mSkipInvalidStruct = false;
    ctx.mCfg.mSkipUnknownStruct = false;

    auto& ds = ctx.mDs;
    GenericParser parser{ctx};

    PageRec page;
    page.view = aView;

    FutureDataLst future{ctx};

    parser.auto_read_prefixes(Structure::Page, future);
    parser.readPreamble();
    future.checkpoint();

    page.name     = ds.readStringLenZeroTerm();
    page.pageSize = ds.readStringLenZeroTerm();

    const std::string where = fmt::format("page \"{}\"", page.name);

    PageSettings settings{ctx};
    settings.read();

    const uint16_t lenTitleBlocks = ds.readUint16();
    for(size_t i = 0; i < lenTitleBlocks; ++i)
    {
        auto rec = dynamic_pointer_cast<StructTitleBlock>(readRecord(ctx, parser, where, page.unread));
        if(rec)
            page.titleBlocks.push_back(rec->name);
    }

    const uint16_t lenT0x34 = ds.readUint16();
    for(size_t i = 0; i < lenT0x34; ++i)
    {
        auto rec = dynamic_pointer_cast<StructT0x34>(readRecord(ctx, parser, where, page.unread));
        if(rec)
            page.pageNetIds.push_back(rec->id);
    }

    const uint16_t lenT0x35 = ds.readUint16();
    for(size_t i = 0; i < lenT0x35; ++i)
    {
        auto rec = dynamic_pointer_cast<StructT0x35>(readRecord(ctx, parser, where, page.unread));
        if(rec)
            page.pageNetIds.push_back(rec->id);
    }

    const uint16_t lenNets = ds.readUint16();
    for(size_t i = 0; i < lenNets; ++i)
    {
        const std::string net = ds.readStringLenZeroTerm();
        const uint32_t id     = ds.readUint32();
        page.netMap.push_back({net, id});
    }

    const uint16_t lenWires = ds.readUint16();
    for(size_t i = 0; i < lenWires; ++i)
        page.wires.push_back(readWire(ctx, parser, where, page.unread));

    const uint16_t lenInstances = ds.readUint16();
    for(size_t i = 0; i < lenInstances; ++i)
    {
        const auto typeByte = ds.peek(1)[0];
        if(typeByte == static_cast<uint8_t>(Structure::PlacedInstance))
        {
            page.instances.push_back(readPlacedInstance(ctx, parser, where, page.unread));
        }
        else if(typeByte == static_cast<uint8_t>(Structure::DrawnInstance))
        {
            const size_t startOfRecord = ds.getCurrentOffset();
            try
            {
                page.instances.push_back(readDrawnInstance(ctx, parser, where, page.unread));
            }
            catch(const std::exception& e)
            {
                throw std::runtime_error(fmt::format("hierarchical block at 0x{:x}, stopped at 0x{:x}: {}", startOfRecord,
                    ds.getCurrentOffset(), e.what()));
            }
        }
        else
        {
            gWarnings.add(fmt::format(
                "{}: instance record of type {} is not read: its connectivity is missing", where, static_cast<int>(typeByte)));
            ++page.unread;
            FutureDataLst skip{ctx};
            parser.auto_read_prefixes(skip);
            skip.readRestOfStructure();
        }
    }

    const uint16_t lenPorts = ds.readUint16();
    for(size_t i = 0; i < lenPorts; ++i)
    {
        page.ports.push_back(readConnector(ctx, parser, Structure::Port, where, page.unread));
    }

    const uint16_t lenGlobals = ds.readUint16();
    for(size_t i = 0; i < lenGlobals; ++i)
    {
        page.globals.push_back(readConnector(ctx, parser, Structure::Global, where, page.unread));
        page.globals.back().raw5 = ds.readBytes(5);
    }

    const uint16_t lenOffPage = ds.readUint16();
    for(size_t i = 0; i < lenOffPage; ++i)
    {
        page.offPage.push_back(readConnector(ctx, parser, Structure::OffPageConnector, where, page.unread));
        page.offPage.back().raw5 = ds.readBytes(5);
    }

    const uint16_t lenErc = ds.readUint16();
    for(size_t i = 0; i < lenErc; ++i)
        readRecord(ctx, parser, where, page.unread);

    const uint16_t lenBusEntries = ds.readUint16();
    for(size_t i = 0; i < lenBusEntries; ++i)
    {
        auto rec = dynamic_pointer_cast<StructBusEntry>(readRecord(ctx, parser, where, page.unread));
        if(rec)
            page.busEntries.push_back({rec->startX, rec->startY, rec->endX, rec->endY});
    }

    const uint16_t lenGraphics = ds.readUint16();
    for(size_t i = 0; i < lenGraphics; ++i)
    {
        readRecord(ctx, parser, where, page.unread);
        ++page.graphics;
    }

    for(int block = 0; block < 2; ++block)
    {
        const uint16_t len = ds.readUint16();
        for(size_t i = 0; i < len; ++i)
            readRecord(ctx, parser, where, page.unread);
    }

    future.checkpoint();
    future.sanitizeCheckpoints();
    ds.sanitizeEoF();

    return page;
}

// ---------------------------------------------------------------------------
// Views/<name>/Schematic: page order. StreamSchematic::read() drops the names.
// ---------------------------------------------------------------------------
std::vector<std::string> readSchematicPageOrder(ContainerContext& aContainerCtx, const fs::path& aPath)
{
    StreamContext ctx{aContainerCtx, aPath};
    auto& ds = ctx.mDs;
    GenericParser parser{ctx};

    FutureDataLst future{ctx};
    parser.auto_read_prefixes(Structure::SchLib, future);
    parser.readPreamble();
    future.checkpoint();
    future.sanitizeCheckpoints();

    ds.readStringLenZeroTerm(); // schematic name
    ds.readBytes(4);

    std::vector<std::string> names;
    const uint16_t count = ds.readUint16();
    for(size_t i = 0; i < count; ++i)
        names.push_back(ds.readStringLenZeroTerm());
    return names;
}

// ---------------------------------------------------------------------------
// Views/<name>/Hierarchy: Capture's own table of the flattened design. Net names
// and the number of part and off-page occurrences are used as a cross check.
// Its pin-to-net links, if it has any, are not understood.
// ---------------------------------------------------------------------------
struct HierarchyRec
{
    std::string view;
    std::vector<std::pair<uint32_t, std::string>> nets;
    size_t pages     = 0;
    size_t offPages  = 0;
    size_t instances = 0;
};

// The record counts change width between file versions in a way the parser can
// only find by trying (see StreamHierarchy::read()).
bool tryReadHierarchy(ContainerContext& aContainerCtx, const fs::path& aPath, int aVersionBits, HierarchyRec& aOut)
{
    StreamContext ctx{aContainerCtx, aPath};
    auto& ds = ctx.mDs;
    GenericParser parser{ctx};

    try
    {
        HierarchyRec out;
        out.view = aOut.view;

        ds.readBytes(9);
        ds.readStringLenZeroTerm();
        ds.readBytes(7);

        const uint16_t lenBlocks = ds.readUint16();
        for(size_t i = 0; i < lenBlocks; ++i)
        {
            parser.readStructure();
            ds.readBytes(4);
            ds.readStringLenZeroTerm();
        }

        const uint16_t lenNets = ds.readUint16();
        for(size_t i = 0; i < lenNets; ++i)
        {
            parser.readStructure();
            const uint32_t id      = ds.readUint32();
            const std::string name = ds.readStringLenZeroTerm();
            out.nets.push_back({id, name});
        }

        const uint16_t lenPages = ds.readUint16();
        for(size_t i = 0; i < lenPages; ++i)
        {
            parser.readStructure();
            ds.readBytes(8);
        }
        out.pages = lenPages;

        const uint32_t lenOff = (aVersionBits & 0x01) ? ds.readUint32() : ds.readUint16();
        for(size_t i = 0; i < lenOff; ++i)
        {
            parser.readStructure();
            ds.readBytes(8);
        }
        out.offPages = lenOff;

        if(aVersionBits & 0x04)
            ds.readBytes(8);

        const uint32_t lenInst = (aVersionBits & 0x08) ? ds.readUint32() : ds.readUint16();
        for(size_t i = 0; i < lenInst; ++i)
        {
            parser.readStructure();
            ds.readBytes(27);
            const uint16_t lenPins = ds.readUint16();
            for(size_t j = 0; j < lenPins; ++j)
            {
                parser.readStructure();
                ds.readBytes(6);
            }
            ds.readBytes(10);
        }
        out.instances = lenInst;

        ds.sanitizeEoF();
        aOut = std::move(out);
        return true;
    }
    catch(const std::exception&)
    {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Library stream
// ---------------------------------------------------------------------------
struct LibraryRec
{
    bool ok = false;
    std::string introduction;
    DatabaseType type = DatabaseType::Design;
    std::vector<std::string> strLst;
    std::vector<std::pair<std::string, std::string>> partAliases;
    std::string version;
    std::string rootSchematic;
    time_t created  = 0;
    time_t modified = 0;
};

// Same layout as StreamLibrary::read(), with two differences: it reads each
// version into a fresh object (see the note at the top of this file), and it
// knows format 4.x, which has 2 more bytes after the version. StreamLibrary
// refuses those files because the bytes after the dates are then not zero.
bool tryReadLibrary(ContainerContext& aContainerCtx, const fs::path& aPath, bool aWideTable, LibraryRec& aOut)
{
    StreamContext ctx{aContainerCtx, aPath};
    auto& ds = ctx.mDs;

    try
    {
        LibraryRec out;

        const size_t start = ds.getCurrentOffset();
        out.introduction   = ds.readStringZeroTerm();
        ds.padRest(start, 32, false);

        if(out.introduction.rfind("OrCAD Windows Design", 0) == 0)
            out.type = DatabaseType::Design;
        else if(out.introduction.rfind("OrCAD Windows Library", 0) == 0)
            out.type = DatabaseType::Library;
        else
            return false;

        const uint16_t major = ds.readUint16();
        const uint16_t minor = ds.readUint16();
        out.version          = fmt::format("{}.{}", major, minor);
        if(major >= 4)
            ds.readBytes(2); // format 4.x keeps one more value here

        out.created  = static_cast<time_t>(ds.readUint32());
        out.modified = static_cast<time_t>(ds.readUint32());
        ds.readBytes(4);

        const uint16_t fonts = ds.readUint16();
        if(fonts == 0)
            return false;
        for(int i = 0; i < static_cast<int>(fonts) - 1; ++i)
        {
            LOGFONTA font{};
            font.read(ctx);
        }

        const uint16_t someLen = ds.readUint16();
        if(someLen != 24)
            return false;
        ds.readBytes(someLen * 2U);
        ds.readBytes(8);

        for(int i = 0; i < 8; ++i)
            ds.readStringLenZeroTerm(); // property to part field mapping

        PageSettings settings{ctx};
        settings.read();

        const uint32_t count = aWideTable ? ds.readUint32() : ds.readUint16();
        for(uint32_t i = 0; i < count; ++i)
            out.strLst.push_back(ds.readStringLenZeroTerm());

        const uint16_t aliases = ds.readUint16();
        for(size_t i = 0; i < aliases; ++i)
        {
            const std::string alias   = ds.readStringLenZeroTerm();
            const std::string package = ds.readStringLenZeroTerm();
            out.partAliases.push_back({alias, package});
        }

        if(out.type == DatabaseType::Design)
        {
            ds.readBytes(8);
            out.rootSchematic = ds.readStringLenZeroTerm();
        }

        ds.sanitizeEoF();

        out.ok = true;
        aOut   = std::move(out);
        return true;
    }
    catch(const std::exception& e)
    {
        if(gVerbose)
            std::cerr << "Library read attempt failed: " << e.what() << "\n";
        return false;
    }
}

LibraryRec readLibrary(ContainerContext& aContainerCtx, const fs::path& aPath)
{
    LibraryRec out;
    if(!tryReadLibrary(aContainerCtx, aPath, true, out))
        tryReadLibrary(aContainerCtx, aPath, false, out);
    return out;
}

// ---------------------------------------------------------------------------
// Symbols and packages. They live in two places: Packages/<name> and the Cache
// stream. A design's instances mostly point into the Cache.
// ---------------------------------------------------------------------------
struct SymbolPinRec
{
    std::string name;
    int32_t x = 0, y = 0, startX = 0, startY = 0;
    std::string type;
    // PinShape::isGlobal in the parser. On 52 real designs it is false only for
    // power pins that have no wire (VCC and GND of a 74xx part): it is the
    // "pin is drawn" bit. A hidden power pin connects to a net by name.
    bool visible = true;
    // The pin's own PSpiceDefaultNet property, for example $G_DPWR.
    std::string defaultNet;
};

struct SymbolRec
{
    std::string kind; // part, global, offpage, port
    std::string name;
    std::string source;
    std::vector<SymbolPinRec> pins;
    bool hasBox = false;
    int x1 = 0, y1 = 0, x2 = 0, y2 = 0;
    PropPairs props;
};

struct DeviceRec
{
    std::string unitRef;
    std::string refDes;
    std::vector<std::string> pinNumbers; // empty string where the pin has no number
    PropPairs props;
};

struct PackageRec
{
    std::string name;
    std::string refDes;
    std::string footprint;
    std::string source;
    std::vector<DeviceRec> devices;
    std::vector<std::string> cells;
    PropPairs props;
};

// Same layout as StructDevice::read(), but a pin without a number keeps its
// position. StructDevice leaves it out, which shifts all later pin numbers.
DeviceRec readDevice(StreamContext& aCtx, GenericParser& aParser)
{
    auto& ds = aCtx.mDs;
    DeviceRec d;

    FutureDataLst future{aCtx};
    const Structure type = readPrefixes(aCtx, aParser, future, &d.props);
    if(type != Structure::Device)
        throw std::runtime_error(fmt::format("expected Device, got {}", OOCP::to_string(type)));

    aParser.readPreamble();
    future.checkpoint();

    d.unitRef = ds.readStringLenZeroTerm();
    d.refDes  = ds.readStringLenZeroTerm();

    const uint16_t pinCount = ds.readUint16();
    for(size_t i = 0; i < pinCount; ++i)
    {
        const size_t offset = ds.getCurrentOffset();
        const int16_t len   = ds.readInt16();
        ds.setCurrentOffset(offset);
        if(len == -1)
        {
            ds.readInt16();
            d.pinNumbers.push_back("");
            continue;
        }
        d.pinNumbers.push_back(ds.readStringLenZeroTerm());
        ds.readUint8(); // pin ignore bit and pin group
    }

    future.checkpoint();
    future.sanitizeCheckpoints();

    return d;
}

// Same layout as StructPackage::read().
PackageRec readPackage(StreamContext& aCtx, GenericParser& aParser, const std::string& aSource)
{
    auto& ds = aCtx.mDs;
    PackageRec p;
    p.source = aSource;

    FutureDataLst future{aCtx};
    const Structure type = readPrefixes(aCtx, aParser, future, &p.props);
    if(type != Structure::Package)
        throw std::runtime_error(fmt::format("expected Package, got {}", OOCP::to_string(type)));

    aParser.readPreamble();
    future.checkpoint();

    p.name = ds.readStringLenZeroTerm();
    ds.readStringLenZeroTerm(); // source library
    future.checkpoint();

    p.refDes = ds.readStringLenZeroTerm();
    ds.readStringLenZeroTerm();
    p.footprint = ds.readStringLenZeroTerm();

    const uint16_t lenDevices = ds.readUint16();
    for(size_t i = 0; i < lenDevices; ++i)
        p.devices.push_back(readDevice(aCtx, aParser));

    future.checkpoint();
    future.sanitizeCheckpoints();

    return p;
}

template <typename T>
void addPins(SymbolRec& aOut, const std::vector<std::unique_ptr<T>>& aPins)
{
    for(const auto& pin : aPins)
    {
        if(!pin)
            continue;
        aOut.pins.push_back({pin->name, pin->hotptX, pin->hotptY, pin->startX, pin->startY, OOCP::to_string(pin->portType),
            pin->pinShape.isGlobal, {}});
    }
}

// Property pairs of the record at the current offset, without consuming it.
PropPairs peekProps(StreamContext& aCtx, GenericParser& aParser)
{
    auto& ds           = aCtx.mDs;
    const size_t start = ds.getCurrentOffset();
    PropPairs props;
    FutureDataLst future{aCtx};
    readPrefixes(aCtx, aParser, future, &props);
    ds.clear();
    ds.setCurrentOffset(start);
    return props;
}

// Same layout as StructLibraryPart::read(), keeping the properties of each pin
// (read_single_prefix_short drops them). A pin slot the file leaves empty keeps
// its place, so that pin order numbers stay right.
SymbolRec readLibraryPart(StreamContext& aCtx, GenericParser& aParser, const std::string& aSource, const std::vector<std::string>& aStr)
{
    auto& ds = aCtx.mDs;

    SymbolRec out;
    out.kind   = "part";
    out.source = aSource;

    FutureDataLst future{aCtx};
    readPrefixes(aCtx, aParser, future, &out.props);
    aParser.readPreamble();
    future.checkpoint();

    out.name = ds.readStringLenZeroTerm();
    ds.readStringLenZeroTerm(); // source library
    future.checkpoint();

    ds.readBytes(4);

    const uint16_t lenPrimitives = ds.readUint16();
    const size_t nextCheckpoint  = future.getNextCheckpointPos().value_or(0U);
    for(size_t i = 0; i < lenPrimitives; ++i)
    {
        const Primitive primitive = aParser.readPrefixPrimitive();
        if(primitive == Primitive::SymbolVector)
            ds.setCurrentOffset(ds.getCurrentOffset() - 1U);
        aParser.readPrimitive(primitive);

        // Some primitives have trailing bytes of unknown length.
        for(int discard = 0; discard < 64 && ds.getCurrentOffset() < nextCheckpoint; ++discard)
        {
            const auto prefix = ds.peek(2);
            bool valid        = true;
            try
            {
                ToPrimitive(prefix[0]);
            }
            catch(...)
            {
                valid = false;
            }
            if(prefix[0] == prefix[1] && valid)
                break;
            ds.discardBytes(1U);
        }
    }

    if(ds.getCurrentOffset() < nextCheckpoint)
        future.readUntilNextFutureData("after the primitives of a library part");
    future.checkpoint();

    const uint16_t lenPins = ds.readUint16();
    for(size_t i = 0; i < lenPins; ++i)
    {
        if(std::vector<uint8_t>{0U} == ds.peek(1U))
        {
            ds.readBytes(1U);
            out.pins.push_back({});
            continue;
        }

        const PropPairs pinProps = peekProps(aCtx, aParser);
        auto rec                 = aParser.readStructure();
        auto* pin                = dynamic_cast<StructSymbolPin*>(rec.get());
        if(pin == nullptr)
            throw std::runtime_error("expected a symbol pin");

        SymbolPinRec row{pin->name, pin->hotptX, pin->hotptY, pin->startX, pin->startY, OOCP::to_string(pin->portType),
            pin->pinShape.isGlobal, {}};
        for(const auto& [nameIdx, valueIdx] : pinProps)
        {
            if(nameIdx < aStr.size() && valueIdx < aStr.size() && aStr[nameIdx] == "PSpiceDefaultNet")
                row.defaultNet = aStr[valueIdx];
        }
        out.pins.push_back(std::move(row));
    }

    const uint16_t lenProps = ds.readUint16();
    for(size_t i = 0; i < lenProps; ++i)
        aParser.readStructure();

    future.checkpoint();

    if(!future.empty() && future.cbegin()->getStopOffset() > ds.getCurrentOffset())
    {
        aParser.readPreamble();
        StructGeneralProperties general{aCtx};
        general.read();
        future.checkpoint();
    }

    future.sanitizeCheckpoints();

    return out;
}

// A symbol record ends its drawing part with its bounding box: 4 x int16 right
// before the second last checkpoint. StructSthInPages0::read_raw() reads it into
// local variables only. Returns false if this record has another layout.
bool peekSymbolBox(StreamContext& aCtx, GenericParser& aParser, SymbolRec& aOut)
{
    auto& ds           = aCtx.mDs;
    const size_t start = ds.getCurrentOffset();

    bool found = false;
    try
    {
        FutureDataLst future{aCtx};
        readPrefixes(aCtx, aParser, future, nullptr);

        std::vector<size_t> stops;
        for(const auto& f : future)
            stops.push_back(f.getStopOffset());
        std::sort(stops.begin(), stops.end());

        if(stops.size() >= 2 && stops[stops.size() - 2] >= 8)
        {
            ds.clear();
            ds.setCurrentOffset(stops[stops.size() - 2] - 8);
            const int x1 = ds.readInt16();
            const int y1 = ds.readInt16();
            const int x2 = ds.readInt16();
            const int y2 = ds.readInt16();
            if(x1 < x2 && y1 < y2 && x2 - x1 < 20000 && y2 - y1 < 20000)
            {
                aOut.x1     = x1;
                aOut.y1     = y1;
                aOut.x2     = x2;
                aOut.y2     = y2;
                aOut.hasBox = true;
                found       = true;
            }
        }
    }
    catch(const std::exception&)
    {
    }

    ds.clear();
    ds.setCurrentOffset(start);
    return found;
}

struct SymbolStore
{
    std::vector<SymbolRec> symbols;
    std::vector<PackageRec> packages;

    // Reads one symbol record at the current offset. StructPortSymbol::read()
    // parses its content into a local object, so that type is read here.
    void readSymbol(StreamContext& aCtx, GenericParser& aParser, const std::string& aSource, const std::vector<std::string>& aStr)
    {
        const uint8_t typeByte = aCtx.mDs.peek(1)[0];

        if(typeByte == static_cast<uint8_t>(Structure::LibraryPart))
        {
            symbols.push_back(readLibraryPart(aCtx, aParser, aSource, aStr));
            return;
        }

        PropPairs props;
        {
            const size_t start = aCtx.mDs.getCurrentOffset();
            FutureDataLst future{aCtx};
            readPrefixes(aCtx, aParser, future, &props);
            aCtx.mDs.clear();
            aCtx.mDs.setCurrentOffset(start);
        }

        if(typeByte == static_cast<uint8_t>(Structure::PortSymbol))
        {
            StructLibraryPart part{aCtx};
            part.read();
            SymbolRec s{"port", part.name, aSource, {}};
            addPins(s, part.symbolPins);
            s.props = std::move(props);
            symbols.push_back(std::move(s));
            return;
        }

        SymbolRec box;
        const bool wantBox = typeByte == static_cast<uint8_t>(Structure::GlobalSymbol) ||
                             typeByte == static_cast<uint8_t>(Structure::OffPageSymbol);
        if(wantBox)
            peekSymbolBox(aCtx, aParser, box);

        auto rec              = aParser.readStructure();
        const size_t countOld = symbols.size();
        add(rec.get(), aSource);
        if(symbols.size() > countOld)
            symbols.back().props = std::move(props);
        if(wantBox && symbols.size() > countOld)
        {
            symbols.back().hasBox = box.hasBox;
            symbols.back().x1     = box.x1;
            symbols.back().y1     = box.y1;
            symbols.back().x2     = box.x2;
            symbols.back().y2     = box.y2;
        }
    }

    void add(Record* aRecord, const std::string& aSource)
    {
        if(auto* global = dynamic_cast<StructGlobalSymbol*>(aRecord))
        {
            SymbolRec s{"global", global->name, aSource, {}};
            addPins(s, global->symbolPins);
            symbols.push_back(std::move(s));
        }
        else if(auto* offPage = dynamic_cast<StructOffPageSymbol*>(aRecord))
        {
            SymbolRec s{"offpage", offPage->name, aSource, {}};
            addPins(s, offPage->symbolPins);
            symbols.push_back(std::move(s));
        }
    }
};

// ---------------------------------------------------------------------------
// The old format (Library version 2.x). PSpice Model Editor still writes it for
// vendor libraries. Same fields in the same order as the current format, but:
//   no long prefixes and no preamble, so a record has no length and an unknown
//   record cannot be skipped; property pairs and string indexes are 16 bit;
//   the 14 "value, path, name, type" bytes of an instance are 8.
// The parser has no reader for it. Everything below is read by layout. The
// graphics at the end of a page are not needed and are not read.
// ---------------------------------------------------------------------------
uint8_t oldPrefix(DataStream& aDs, PropPairs* aProps = nullptr)
{
    const uint8_t type = aDs.readUint8();
    const int16_t n    = aDs.readInt16();
    for(int i = 0; i < n; ++i)
    {
        const uint16_t name  = aDs.readUint16();
        const uint16_t value = aDs.readUint16();
        if(aProps != nullptr)
            aProps->push_back({name == 0xFFFF ? 0xFFFFFFFFU : name, value == 0xFFFF ? 0xFFFFFFFFU : value});
    }
    return type;
}

void oldExpect(uint8_t aGot, uint8_t aWanted, const char* aWhat, DataStream& aDs)
{
    if(aGot != aWanted)
    {
        throw std::runtime_error(fmt::format(
            "old format: expected {} (type {}) but found type {} at 0x{:x}", aWhat, aWanted, aGot, aDs.getCurrentOffset()));
    }
}

void oldDisplayProps(DataStream& aDs)
{
    const uint16_t count = aDs.readUint16();
    for(size_t i = 0; i < count; ++i)
    {
        oldExpect(oldPrefix(aDs), static_cast<uint8_t>(Structure::SymbolDisplayProp), "a display property", aDs);
        aDs.readBytes(12);
    }
}

void oldPrimitive(DataStream& aDs)
{
    const uint8_t type = aDs.readUint8();
    switch(type)
    {
        case 40: // rect: 4 coordinates, line style and width, fill and hatch
        case 43: // ellipse: the same
            aDs.readBytes(32);
            break;
        case 41: // line
            aDs.readBytes(24);
            break;
        case 42: // arc
            aDs.readBytes(40);
            break;
        case 44: // polygon
        {
            aDs.readBytes(16);
            const uint16_t points = aDs.readUint16();
            aDs.readBytes(points * 4U);
            break;
        }
        case 45: // polyline
        case 87: // bezier
        {
            aDs.readBytes(8);
            const uint16_t points = aDs.readUint16();
            aDs.readBytes(points * 4U);
            break;
        }
        case 46: // comment text
            aDs.readBytes(28);
            aDs.readStringLenZeroTerm();
            break;
        case 47: // bitmap
        {
            aDs.readBytes(32);
            const uint32_t size = aDs.readUint32();
            aDs.discardBytes(size);
            break;
        }
        default:
            throw std::runtime_error(
                fmt::format("old format: symbol drawing primitive {} at 0x{:x} is not known", type, aDs.getCurrentOffset()));
    }
}

SymbolRec oldSymbol(DataStream& aDs, const std::string& aSource, const std::vector<std::string>& aStr)
{
    SymbolRec out;
    out.source = aSource;

    const uint8_t type = oldPrefix(aDs, &out.props);
    switch(static_cast<Structure>(type))
    {
        case Structure::LibraryPart:
            out.kind = "part";
            break;
        case Structure::GlobalSymbol:
            out.kind = "global";
            break;
        case Structure::OffPageSymbol:
            out.kind = "offpage";
            break;
        case Structure::PortSymbol:
            out.kind = "port";
            break;
        default:
            out.kind = "other"; // title block, ERC marker
            break;
    }

    out.name = aDs.readStringLenZeroTerm();
    aDs.readStringLenZeroTerm(); // source library
    aDs.readUint32();            // color

    const uint16_t primitives = aDs.readUint16();
    for(size_t i = 0; i < primitives; ++i)
        oldPrimitive(aDs);

    out.x1     = aDs.readInt16();
    out.y1     = aDs.readInt16();
    out.x2     = aDs.readInt16();
    out.y2     = aDs.readInt16();
    out.hasBox = out.x1 < out.x2 && out.y1 < out.y2;

    const uint16_t pins = aDs.readUint16();
    for(size_t i = 0; i < pins; ++i)
    {
        PropPairs pinProps;
        const uint8_t pinType = oldPrefix(aDs, &pinProps);
        if(pinType != static_cast<uint8_t>(Structure::SymbolPinScalar) && pinType != static_cast<uint8_t>(Structure::SymbolPinBus))
            oldExpect(pinType, static_cast<uint8_t>(Structure::SymbolPinScalar), "a symbol pin", aDs);

        SymbolPinRec pin;
        pin.name   = aDs.readStringLenZeroTerm();
        pin.startX = aDs.readInt32();
        pin.startY = aDs.readInt32();
        pin.x      = aDs.readInt32();
        pin.y      = aDs.readInt32();
        pin.visible = ToPinShape(aDs.readUint16()).isGlobal;
        aDs.readBytes(2);
        pin.type = OOCP::to_string(ToPortType(aDs.readUint32()));
        aDs.readBytes(4);
        oldDisplayProps(aDs);
        for(const auto& [nameIdx, valueIdx] : pinProps)
        {
            if(nameIdx < aStr.size() && valueIdx < aStr.size() && aStr[nameIdx] == "PSpiceDefaultNet")
                pin.defaultNet = aStr[valueIdx];
        }
        out.pins.push_back(std::move(pin));
    }

    oldDisplayProps(aDs);

    if(type == static_cast<uint8_t>(Structure::LibraryPart) || type == static_cast<uint8_t>(Structure::PortSymbol))
    {
        for(int i = 0; i < 4; ++i)
            aDs.readStringLenZeroTerm(); // implementation path, implementation, reference, value
        aDs.readBytes(2);
    }

    return out;
}

DeviceRec oldDevice(DataStream& aDs)
{
    DeviceRec d;
    oldExpect(oldPrefix(aDs, &d.props), static_cast<uint8_t>(Structure::Device), "a device", aDs);
    d.unitRef = aDs.readStringLenZeroTerm();
    d.refDes  = aDs.readStringLenZeroTerm();

    const uint16_t pinCount = aDs.readUint16();
    for(size_t i = 0; i < pinCount; ++i)
    {
        const size_t offset = aDs.getCurrentOffset();
        const int16_t len   = aDs.readInt16();
        aDs.setCurrentOffset(offset);
        if(len == -1)
        {
            aDs.readInt16();
            d.pinNumbers.push_back("");
            continue;
        }
        d.pinNumbers.push_back(aDs.readStringLenZeroTerm());
        aDs.readUint8();
    }
    return d;
}

PackageRec oldPackage(DataStream& aDs, const std::string& aSource)
{
    PackageRec p;
    p.source = aSource;
    oldExpect(oldPrefix(aDs, &p.props), static_cast<uint8_t>(Structure::Package), "a package", aDs);
    p.name = aDs.readStringLenZeroTerm();
    aDs.readStringLenZeroTerm(); // source library
    p.refDes = aDs.readStringLenZeroTerm();
    aDs.readStringLenZeroTerm();
    p.footprint = aDs.readStringLenZeroTerm();

    const uint16_t devices = aDs.readUint16();
    for(size_t i = 0; i < devices; ++i)
        p.devices.push_back(oldDevice(aDs));
    return p;
}

void oldPartCell(DataStream& aDs)
{
    oldExpect(oldPrefix(aDs), static_cast<uint8_t>(Structure::PartCell), "a part cell", aDs);
    aDs.readStringLenZeroTerm();
    aDs.readStringLenZeroTerm();
    const uint16_t views = aDs.readUint16();
    for(size_t i = 0; i < views; ++i)
        aDs.readStringLenZeroTerm();
}

WireRec oldWire(DataStream& aDs)
{
    WireRec w;
    const uint8_t type = oldPrefix(aDs, &w.props);
    if(type != static_cast<uint8_t>(Structure::WireScalar) && type != static_cast<uint8_t>(Structure::WireBus))
        oldExpect(type, static_cast<uint8_t>(Structure::WireScalar), "a wire", aDs);
    w.bus  = type == static_cast<uint8_t>(Structure::WireBus);
    w.dbId = aDs.readUint32();
    w.net  = aDs.readUint32();
    aDs.readUint32(); // color
    w.x1 = aDs.readInt32();
    w.y1 = aDs.readInt32();
    w.x2 = aDs.readInt32();
    w.y2 = aDs.readInt32();
    aDs.readUint8();

    const uint16_t aliases = aDs.readUint16();
    for(size_t i = 0; i < aliases; ++i)
    {
        oldExpect(oldPrefix(aDs), static_cast<uint8_t>(Structure::Alias), "a net alias", aDs);
        AliasRec a;
        a.x = aDs.readInt32();
        a.y = aDs.readInt32();
        aDs.readBytes(12); // color, rotation, font
        a.name = aDs.readStringLenZeroTerm();
        w.aliases.push_back(std::move(a));
    }

    oldDisplayProps(aDs);
    return w;
}

InstRec oldInstance(DataStream& aDs, const std::vector<std::string>& aStr)
{
    InstRec inst;
    const uint8_t type = oldPrefix(aDs, &inst.props);
    inst.block         = type == static_cast<uint8_t>(Structure::DrawnInstance);
    if(!inst.block)
        oldExpect(type, static_cast<uint8_t>(Structure::PlacedInstance), "a placed part", aDs);

    inst.u0      = aDs.readBytes(8);
    inst.pkgName = aDs.readStringLenZeroTerm();
    inst.dbId    = aDs.readUint32();
    inst.u1      = aDs.readBytes(8);
    inst.x       = aDs.readInt16();
    inst.y       = aDs.readInt16();
    inst.u2      = aDs.readBytes(4);
    inst.rotation = inst.u2[1] & 0x03;
    inst.mirror   = (inst.u2[1] & 0x04) != 0;

    oldDisplayProps(aDs);
    inst.u3 = aDs.readBytes(1);

    if(inst.block)
    {
        const SymbolRec symbol = oldSymbol(aDs, "block", aStr);
        for(const auto& pin : symbol.pins)
            inst.blockPins.push_back(pin.name);
    }

    inst.ref = aDs.readStringLenZeroTerm();
    inst.u4  = aDs.readBytes(8);

    const auto index = [&](size_t aAt)
    {
        const uint16_t v = le16(inst.u4, aAt);
        return v == 0xFFFF ? 0xFFFFFFFFU : static_cast<uint32_t>(v);
    };
    inst.valueIdx    = index(0);
    inst.implPathIdx = index(2);
    inst.implNameIdx = index(4);
    inst.implType    = le16(inst.u4, 6);

    const uint16_t pins = aDs.readUint16();
    for(size_t i = 0; i < pins; ++i)
    {
        oldExpect(oldPrefix(aDs), static_cast<uint8_t>(Structure::T0x10), "a pin", aDs);
        PinRec pin;
        pin.order = aDs.readUint16();
        pin.x     = aDs.readInt16();
        pin.y     = aDs.readInt16();
        pin.id    = aDs.readUint32();
        pin.unk   = aDs.readUint32();
        oldDisplayProps(aDs);
        inst.pins.push_back(pin);
    }

    if(!inst.block)
    {
        inst.sourcePkg = aDs.readStringLenZeroTerm();
        inst.u5        = aDs.readBytes(2);
        inst.section   = le16(inst.u5, 0);
    }
    return inst;
}

ConnRec oldConnector(DataStream& aDs, Structure aExpected)
{
    ConnRec c;
    oldExpect(oldPrefix(aDs, &c.props), static_cast<uint8_t>(aExpected), "a connector", aDs);
    c.nameIdx = aDs.readUint16();
    aDs.readBytes(6); // source library index and a stamp
    c.symbol   = aDs.readStringLenZeroTerm();
    c.dbId     = aDs.readUint32();
    c.y        = aDs.readInt16();
    c.x        = aDs.readInt16();
    c.y2       = aDs.readInt16();
    c.x2       = aDs.readInt16();
    c.x1       = aDs.readInt16();
    c.y1       = aDs.readInt16();
    aDs.readUint8(); // color
    c.raw3     = aDs.readBytes(3);
    c.rotation = c.raw3[0] & 0x07;
    oldDisplayProps(aDs);
    aDs.readUint8(); // symbol type
    return c;
}

PageRec oldPage(ContainerContext& aContainerCtx, const fs::path& aPath, const std::string& aView, const std::vector<std::string>& aStr)
{
    StreamContext ctx{aContainerCtx, aPath};
    auto& ds = ctx.mDs;

    PageRec page;
    page.view = aView;

    oldExpect(oldPrefix(ds), static_cast<uint8_t>(Structure::Page), "a page", ds);
    page.name     = ds.readStringLenZeroTerm();
    page.pageSize = ds.readStringLenZeroTerm();

    PageSettings settings{ctx};
    settings.read();

    const uint16_t titleBlocks = ds.readUint16();
    for(size_t i = 0; i < titleBlocks; ++i)
    {
        oldExpect(oldPrefix(ds), static_cast<uint8_t>(Structure::TitleBlock), "a title block", ds);
        ds.readBytes(8);
        page.titleBlocks.push_back(ds.readStringLenZeroTerm());
        ds.readBytes(4 + 12 + 4);
        oldDisplayProps(ds);
        ds.readBytes(1 + 12);
    }

    const uint16_t netIds = ds.readUint16();
    for(size_t i = 0; i < netIds; ++i)
    {
        page.pageNetIds.push_back(ds.readUint32());
        ds.readStringLenZeroTerm();
    }

    if(ds.readUint16() != 0)
        throw std::runtime_error("old format: net records of type 0x35 are not known");

    const uint16_t nets = ds.readUint16();
    for(size_t i = 0; i < nets; ++i)
    {
        const std::string name = ds.readStringLenZeroTerm();
        const uint32_t id      = ds.readUint32();
        page.netMap.push_back({name, id});
    }

    const uint16_t wires = ds.readUint16();
    for(size_t i = 0; i < wires; ++i)
        page.wires.push_back(oldWire(ds));

    const uint16_t instances = ds.readUint16();
    for(size_t i = 0; i < instances; ++i)
        page.instances.push_back(oldInstance(ds, aStr));

    const uint16_t ports = ds.readUint16();
    for(size_t i = 0; i < ports; ++i)
    {
        page.ports.push_back(oldConnector(ds, Structure::Port));
        ds.readBytes(9);
    }

    const uint16_t globals = ds.readUint16();
    for(size_t i = 0; i < globals; ++i)
    {
        page.globals.push_back(oldConnector(ds, Structure::Global));
        page.globals.back().raw5 = ds.readBytes(5);
    }

    const uint16_t offPage = ds.readUint16();
    for(size_t i = 0; i < offPage; ++i)
    {
        page.offPage.push_back(oldConnector(ds, Structure::OffPageConnector));
        page.offPage.back().raw5 = ds.readBytes(5);
    }

    return page;
}

void oldPackageStream(ContainerContext& aContainerCtx, const fs::path& aPath, SymbolStore& aStore, const std::vector<std::string>& aStr)
{
    StreamContext ctx{aContainerCtx, aPath};
    auto& ds = ctx.mDs;

    const std::string source = "Packages/" + aPath.stem().string();
    SymbolStore local;

    const uint16_t cells = ds.readUint16();
    for(size_t i = 0; i < cells; ++i)
    {
        oldPartCell(ds);
        const uint16_t parts = ds.readUint16();
        for(size_t j = 0; j < parts; ++j)
            local.symbols.push_back(oldSymbol(ds, source, aStr));
    }
    local.packages.push_back(oldPackage(ds, source));
    ds.sanitizeEoF();

    aStore.symbols.insert(aStore.symbols.end(), local.symbols.begin(), local.symbols.end());
    aStore.packages.insert(aStore.packages.end(), local.packages.begin(), local.packages.end());
}

// Packages/<name>, same order as StreamPackage::read().
void readPackageStream(ContainerContext& aContainerCtx, const fs::path& aPath, SymbolStore& aStore, const std::vector<std::string>& aStr)
{
    StreamContext ctx{aContainerCtx, aPath};
    auto& ds = ctx.mDs;
    GenericParser parser{ctx};

    const std::string source = "Packages/" + aPath.stem().string();

    SymbolStore local;

    const uint16_t lenCells = ds.readUint16();
    for(size_t i = 0; i < lenCells; ++i)
    {
        parser.readStructure(); // PartCell

        const uint16_t lenParts = ds.readUint16();
        for(size_t j = 0; j < lenParts; ++j)
            local.readSymbol(ctx, parser, source, aStr);
    }

    local.packages.push_back(readPackage(ctx, parser, source));

    ds.sanitizeEoF();

    aStore.symbols.insert(aStore.symbols.end(), local.symbols.begin(), local.symbols.end());
    aStore.packages.insert(aStore.packages.end(), local.packages.begin(), local.packages.end());
}

// Same control flow as StreamCache::read(), keeping the records it reads.
void readCacheStream(ContainerContext& aContainerCtx, const fs::path& aPath, SymbolStore& aStore, const std::vector<std::string>& aStr, bool aOldFormat)
{
    StreamContext ctx{aContainerCtx, aPath};
    auto& ds = ctx.mDs;
    GenericParser parser{ctx};

    const auto hasStrAfter = [&](size_t aBytes)
    {
        return parser.tryRead(
            [&]()
            {
                ds.readBytes(aBytes);
                ds.readStringLenZeroTerm();
            });
    };

    if(parser.tryRead(
           [&]()
           {
               ds.readBytes(10U);
               ds.sanitizeEoF();
           }))
    {
        return; // empty cache
    }

    ds.readBytes(4);

    while(!ds.isEoF())
    {
        if(!hasStrAfter(0))
        {
            if(hasStrAfter(8))
            {
                ds.readBytes(2);
                ds.readStringLenZeroTerm();
            }
            ds.readBytes(2);
        }

        ds.readStringLenZeroTerm();

        const auto ids = ds.peek(8);
        const std::vector<uint8_t> id0{ids.cbegin(), ids.cbegin() + 4};
        const std::vector<uint8_t> id1{ids.cbegin() + 4, ids.cend()};

        if(id0 != id1)
        {
            uint16_t someVal = 0;
            do
            {
                someVal = ds.readUint16();

                if(ds.isEoF())
                    break;

                if(parser.tryRead(
                       [&]()
                       {
                           ds.readBytes(1);
                           ds.sanitizeEoF();
                       }))
                {
                    ds.readBytes(1);
                    break;
                }

                if(!parser.tryRead([&]() { ds.readStringLenZeroTerm(); }))
                    ds.readBytes(2);

                ds.readStringLenZeroTerm();
            } while(someVal == 0);

            if(ds.isEoF())
                break;
        }

        ds.readUint32();
        ds.readUint32();
        ds.readUint16(); // structure type, the record repeats it

        const uint8_t typeByte = ds.peek(1)[0];
        if(aOldFormat)
        {
            if(typeByte == static_cast<uint8_t>(Structure::Package))
                aStore.packages.push_back(oldPackage(ds, "Cache"));
            else if(typeByte == static_cast<uint8_t>(Structure::PartCell))
                oldPartCell(ds);
            else
                aStore.symbols.push_back(oldSymbol(ds, "Cache", aStr));
        }
        else if(typeByte == static_cast<uint8_t>(Structure::Package))
        {
            aStore.packages.push_back(readPackage(ctx, parser, "Cache"));
        }
        else
        {
            aStore.readSymbol(ctx, parser, "Cache", aStr);
        }
    }

    ds.sanitizeEoF();
}

// Natural order: "P2" before "P10".
bool naturalLess(const std::string& aLeft, const std::string& aRight)
{
    size_t i = 0, j = 0;
    while(i < aLeft.size() && j < aRight.size())
    {
        if(std::isdigit(static_cast<unsigned char>(aLeft[i])) && std::isdigit(static_cast<unsigned char>(aRight[j])))
        {
            size_t ie = i, je = j;
            while(ie < aLeft.size() && std::isdigit(static_cast<unsigned char>(aLeft[ie])))
                ++ie;
            while(je < aRight.size() && std::isdigit(static_cast<unsigned char>(aRight[je])))
                ++je;
            const auto a = std::stoull(aLeft.substr(i, std::min<size_t>(ie - i, 18)));
            const auto b = std::stoull(aRight.substr(j, std::min<size_t>(je - j, 18)));
            if(a != b)
                return a < b;
            i = ie;
            j = je;
            continue;
        }
        const int a = std::tolower(static_cast<unsigned char>(aLeft[i]));
        const int b = std::tolower(static_cast<unsigned char>(aRight[j]));
        if(a != b)
            return a < b;
        ++i;
        ++j;
    }
    return (aLeft.size() - i) < (aRight.size() - j);
}

// ---------------------------------------------------------------------------
// JSON output pieces
// ---------------------------------------------------------------------------
std::string propsJson(const PropPairs& aProps, const std::vector<std::string>& aStr)
{
    std::string out = "{";
    bool first      = true;
    for(const auto& [nameIdx, valueIdx] : aProps)
    {
        // A value index of -1 means the property exists without a value.
        const bool noValue = valueIdx == 0xFFFFFFFFU;
        if(nameIdx >= aStr.size() || (!noValue && valueIdx >= aStr.size()))
        {
            gWarnings.add(fmt::format(
                "property index out of the string table: name {} value {} (table has {})", nameIdx, valueIdx, aStr.size()));
            continue;
        }
        if(!first)
            out += ",";
        first = false;
        out += jstr(aStr[nameIdx]) + ":" + jstr(noValue ? std::string{} : aStr[valueIdx]);
    }
    return out + "}";
}

std::string propValue(const PropPairs& aProps, const std::vector<std::string>& aStr, const std::string& aName)
{
    for(const auto& [nameIdx, valueIdx] : aProps)
    {
        if(nameIdx < aStr.size() && valueIdx < aStr.size() && aStr[nameIdx] == aName)
            return aStr[valueIdx];
    }
    return "";
}

std::string strAt(const std::vector<std::string>& aStr, uint32_t aIdx)
{
    return aIdx < aStr.size() ? aStr[aIdx] : std::string{};
}

std::string connJson(const ConnRec& aConn, const std::vector<std::string>& aStr)
{
    std::string s = fmt::format(
        R"({{"name":{},"symbol":{},"x":{},"y":{},"exact":{},"loc":[{},{}],"rotation":{},"mirror":{},"bbox":[{},{},{},{}],"id":{},"properties":{})",
        jstr(strAt(aStr, aConn.nameIdx)), jstr(aConn.symbol), aConn.hasHot ? aConn.hotX : aConn.x,
        aConn.hasHot ? aConn.hotY : aConn.y, aConn.hasHot ? "true" : "false", aConn.x, aConn.y, (aConn.rotation & 3) * 90,
        (aConn.rotation & 4) ? "true" : "false", aConn.x1, aConn.y1, aConn.x2, aConn.y2, aConn.dbId,
        propsJson(aConn.props, aStr));
    if(gRaw)
        s += fmt::format(R"(,"_raw":{{"r3":"{}","r5":"{}"}})", hexBytes(aConn.raw3), hexBytes(aConn.raw5));
    return s + "}";
}

std::string pageJson(const PageRec& aPage, const LibraryRec& aLib)
{
    std::string out = "{";
    out += fmt::format(R"("name":{},"view":{},"pageSize":{},)", jstr(aPage.name), jstr(aPage.view), jstr(aPage.pageSize));

    out += R"("titleBlocks":)" + jarr(aPage.titleBlocks, [](const std::string& s) { return jstr(s); }) + ",";

    out += R"("nets":)" + jarr(aPage.netMap, [](const std::pair<std::string, uint32_t>& n)
                              { return fmt::format(R"({{"name":{},"id":{}}})", jstr(n.first), n.second); }) + ",";

    out += R"("instances":)" + jarr(aPage.instances, [&](const InstRec& i)
    {
        std::string s = "{";
        s += fmt::format(
            R"("ref":{},"value":{},"sourcePart":{},"part":{},"section":{},"x":{},"y":{},"rotation":{},"mirror":{},"bbox":[{},{},{},{}],"id":{},)",
            jstr(i.ref), jstr(i.block ? std::string{} : strAt(aLib.strLst, i.valueIdx)), jstr(i.sourcePkg), jstr(i.pkgName), i.section, i.x, i.y,
            i.rotation * 90, i.mirror ? "true" : "false", i.bx1, i.by1, i.bx2, i.by2, i.dbId);
        s += fmt::format(R"("implementation":{{"name":{},"path":{},"type":{}}},)", jstr(strAt(aLib.strLst, i.implNameIdx)),
            jstr(strAt(aLib.strLst, i.implPathIdx)), i.implType);
        if(i.block)
            s += R"("block":true,"blockPins":)" + jarr(i.blockPins, [](const std::string& n) { return jstr(n); }) + ",";
        s += R"("properties":)" + propsJson(i.props, aLib.strLst) + ",";
        s += R"("pins":)" + jarr(i.pins, [](const PinRec& p)
        {
            // The order field is negative for pins with the no-connect flag.
            const bool flagged  = (p.order & 0x8000) != 0;
            const int order     = flagged ? 0x10000 - p.order : p.order;
            const std::string w = p.id == 0xFFFFFFFFU ? "-1" : std::to_string(p.id);
            return fmt::format(R"({{"order":{},"x":{},"y":{},"wire":{},"noConnect":{}}})", order, p.x, p.y, w,
                flagged ? "true" : "false");
        });
        if(gRaw)
        {
            s += fmt::format(R"(,"_raw":{{"u0":"{}","u1":"{}","u2":"{}","u3":"{}","u4":"{}","u5":"{}"}})", hexBytes(i.u0),
                hexBytes(i.u1), hexBytes(i.u2), hexBytes(i.u3), hexBytes(i.u4), hexBytes(i.u5));
        }
        return s + "}";
    }) + ",";

    out += R"("wires":)" + jarr(aPage.wires, [&](const WireRec& w)
    {
        std::string s = fmt::format(R"({{"x1":{},"y1":{},"x2":{},"y2":{},"net":{},"id":{},"bus":{},"aliases":)", w.x1, w.y1,
            w.x2, w.y2, w.net, w.dbId, w.bus ? "true" : "false");
        s += jarr(w.aliases, [](const AliasRec& a)
                 { return fmt::format(R"({{"name":{},"x":{},"y":{}}})", jstr(a.name), a.x, a.y); });
        if(!w.props.empty())
            s += R"(,"properties":)" + propsJson(w.props, aLib.strLst);
        return s + "}";
    }) + ",";

    const auto conn = [&](const ConnRec& c) { return connJson(c, aLib.strLst); };
    out += R"("globals":)" + jarr(aPage.globals, conn) + ",";
    out += R"("ports":)" + jarr(aPage.ports, conn) + ",";
    out += R"("offPage":)" + jarr(aPage.offPage, conn) + ",";
    out += R"("busEntries":)" + jarr(aPage.busEntries, [](const BusEntryRec& b)
                                    { return fmt::format(R"({{"x1":{},"y1":{},"x2":{},"y2":{}}})", b.x1, b.y1, b.x2, b.y2); }) + ",";
    out += fmt::format(R"("graphics":{},"unreadRecords":{})", aPage.graphics, aPage.unread);
    return out + "}";
}

// The connection point of a power symbol, off-page connector or port.
// The record's x1, y1 is the symbol's top-left corner. Its x2, y2 can lie further
// out because it includes the name text. The symbol's own size comes from the
// symbol record; when that was not found, the smallest box seen for that symbol
// stands in.
void computeHotPoints(std::vector<PageRec>& aPages, const std::vector<SymbolRec>& aSymbols)
{
    using Key = std::pair<std::string, std::string>;
    std::map<Key, std::pair<int, int>> pinOf;
    std::map<Key, std::pair<int, int>> boxOfSymbol;
    for(const auto& sym : aSymbols)
    {
        if(sym.kind == "part" || sym.kind == "other" || sym.pins.empty())
            continue;
        const int ox = sym.hasBox ? sym.x1 : 0;
        const int oy = sym.hasBox ? sym.y1 : 0;
        pinOf.emplace(Key{sym.kind, sym.name}, std::make_pair(sym.pins.front().x - ox, sym.pins.front().y - oy));
        if(sym.hasBox)
            boxOfSymbol.emplace(Key{sym.kind, sym.name}, std::make_pair(sym.x2 - sym.x1, sym.y2 - sym.y1));
    }

    std::map<Key, std::pair<int, int>> sizeOf;
    const auto boxOf = [](const ConnRec& c)
    { return std::make_pair(std::abs(c.x2 - c.x1), std::abs(c.y2 - c.y1)); };

    const auto measure = [&](const std::string& aKind, const std::vector<ConnRec>& aList)
    {
        for(const auto& c : aList)
        {
            auto [w, h] = boxOf(c);
            if(c.rotation & 1)
                std::swap(w, h);
            auto it = sizeOf.find(Key{aKind, c.symbol});
            if(it == sizeOf.end())
            {
                sizeOf.emplace(Key{aKind, c.symbol}, std::make_pair(w, h));
            }
            else
            {
                it->second.first  = std::min(it->second.first, w);
                it->second.second = std::min(it->second.second, h);
            }
        }
    };

    const auto place = [&](const std::string& aKind, std::vector<ConnRec>& aList)
    {
        for(auto& c : aList)
        {
            const auto pin = pinOf.find(Key{aKind, c.symbol});
            if(pin == pinOf.end())
                continue;

            const auto box      = boxOfSymbol.find(Key{aKind, c.symbol});
            const auto [ws, hs] = box != boxOfSymbol.end() ? box->second : sizeOf[Key{aKind, c.symbol}];
            const int hx        = pin->second.first;
            const int hy        = pin->second.second;

            int dx = hx, dy = hy;
            switch(c.rotation)
            {
                case 0:
                    dx = hx;
                    dy = hy;
                    break;
                case 1:
                    dx = hy;
                    dy = ws - hx;
                    break;
                case 2:
                    dx = ws - hx;
                    dy = hs - hy;
                    break;
                case 3:
                    dx = hs - hy;
                    dy = hx;
                    break;
                case 4:
                    dx = ws - hx;
                    dy = hy;
                    break;
                case 5:
                    dx = hy;
                    dy = hx;
                    break;
                case 6:
                    dx = hx;
                    dy = hs - hy;
                    break;
                default:
                    dx = hs - hy;
                    dy = ws - hx;
                    break;
            }

            c.hotX   = c.x1 + dx;
            c.hotY   = c.y1 + dy;
            c.hasHot = true;
        }
    };

    for(const auto& page : aPages)
    {
        measure("global", page.globals);
        measure("offpage", page.offPage);
        measure("port", page.ports);
    }
    for(auto& page : aPages)
    {
        place("global", page.globals);
        place("offpage", page.offPage);
        place("port", page.ports);
    }
}

std::string symbolJson(const SymbolRec& aSym, const std::vector<std::string>& aStr)
{
    return fmt::format(R"({{"kind":{},"name":{},"source":{},"properties":{},"box":{},"pins":{}}})", jstr(aSym.kind),
        jstr(aSym.name), jstr(aSym.source), propsJson(aSym.props, aStr),
        aSym.hasBox ? fmt::format("[{},{},{},{}]", aSym.x1, aSym.y1, aSym.x2, aSym.y2) : std::string{"null"},
        jarr(aSym.pins, [](const SymbolPinRec& p)
        {
            return fmt::format(R"({{"name":{},"x":{},"y":{},"startX":{},"startY":{},"type":{},"visible":{},"defaultNet":{}}})",
                jstr(p.name), p.x, p.y, p.startX, p.startY, jstr(p.type), p.visible ? "true" : "false", jstr(p.defaultNet));
        }));
}

// One entry per package. "pins" flattens all sections: name, x and y come from
// the section's symbol when it can be found by name ("<cell>.Normal").
std::string packageJson(const PackageRec& aPkg, const std::map<std::string, const SymbolRec*>& aParts, const std::vector<std::string>& aStr)
{
    const auto symbolOf = [&](const DeviceRec& aDevice) -> const SymbolRec*
    {
        for(const std::string& key : {aDevice.refDes + ".Normal", aDevice.refDes, aPkg.name + ".Normal", aPkg.name})
        {
            const auto it = aParts.find(key);
            if(it != aParts.end())
                return it->second;
        }
        return nullptr;
    };

    std::string pins = "[";
    bool first       = true;
    for(size_t d = 0; d < aPkg.devices.size(); ++d)
    {
        const SymbolRec* symbol = symbolOf(aPkg.devices[d]);
        for(size_t i = 0; i < aPkg.devices[d].pinNumbers.size(); ++i)
        {
            if(!first)
                pins += ",";
            first                    = false;
            const SymbolPinRec* pin = symbol != nullptr && i < symbol->pins.size() ? &symbol->pins[i] : nullptr;
            pins += fmt::format(R"({{"name":{},"number":{},"x":{},"y":{},"section":{},"order":{}}})",
                jstr(pin != nullptr ? pin->name : ""), jstr(aPkg.devices[d].pinNumbers[i]), pin != nullptr ? pin->x : 0,
                pin != nullptr ? pin->y : 0, d, i + 1);
        }
    }
    pins += "]";

    std::string out = fmt::format(R"({{"name":{},"source":{},"refDes":{},"footprint":{},"properties":{},)", jstr(aPkg.name),
        jstr(aPkg.source), jstr(aPkg.refDes), jstr(aPkg.footprint), propsJson(aPkg.props, aStr));

    out += R"("sections":)" + jarr(aPkg.devices, [&](const DeviceRec& d)
    {
        return fmt::format(R"({{"unit":{},"cell":{},"properties":{},"pinNumbers":{}}})", jstr(d.unitRef), jstr(d.refDes),
            propsJson(d.props, aStr), jarr(d.pinNumbers, [](const std::string& s) { return jstr(s); }));
    }) + ",";

    out += R"("pins":)" + pins;

    return out + "}";
}

// ---------------------------------------------------------------------------
// The work, done in a child process: it may crash on malformed input.
// ---------------------------------------------------------------------------
int run(const fs::path& aInput, const std::string& aDisplayName)
{
    const auto t0 = std::chrono::steady_clock::now();

    checkCfbf(aInput);

    // The parser opens one log file and one data file per stream.
    rlimit lim{};
    if(getrlimit(RLIMIT_NOFILE, &lim) == 0)
    {
        lim.rlim_cur = std::min<rlim_t>(lim.rlim_max, 10240);
        setrlimit(RLIMIT_NOFILE, &lim);
    }

    auto sink   = std::make_shared<CollectSink>();
    auto logger = std::make_shared<spdlog::logger>("orcad2json", sink);
    logger->set_level(spdlog::level::warn);
    spdlog::set_default_logger(logger);

    ParserConfig cfg{};
    cfg.mKeepTmpFiles = false;
    cfg.mThreadCount  = 1;

    std::unique_ptr<Container> container;
    try
    {
        container = std::make_unique<Container>(aInput, cfg);
    }
    catch(const std::exception& e)
    {
        throw InputError{EXIT_BAD_INPUT, fmt::format("cannot open the container: {}", e.what())};
    }

    ContainerContext& ctx = container->getContext();
    ctx.mLogLevel         = spdlog::level::off;
    ctx.mLogger.set_level(spdlog::level::off);

    const fs::path root = ctx.mExtractedCfbfPath;
    rescueCollidedStreams(aInput, root);

    // Collect streams by kind.
    std::optional<fs::path> libPath;
    std::vector<fs::path> packages;
    std::vector<fs::path> others;
    std::vector<std::pair<std::string, fs::path>> pagePaths, schematicPaths, hierarchyPaths;

    size_t streamCount = 0;
    for(const auto& entry : fs::recursive_directory_iterator(root))
    {
        if(!entry.is_regular_file())
            continue;
        ++streamCount;

        CfbfStreamLocation loc{entry.path(), root};
        const auto& parts = loc.get_vector();

        if(loc.matches_pattern({"Library"}))
            libPath = entry.path();
        else if(loc.matches_pattern({"Packages", std::nullopt}))
            packages.push_back(entry.path());
        else if(loc.matches_pattern({"Views", std::nullopt, "Pages", std::nullopt}))
            pagePaths.push_back({parts[1], entry.path()});
        else if(loc.matches_pattern({"Views", std::nullopt, "Schematic"}))
            schematicPaths.push_back({parts[1], entry.path()});
        else if(loc.matches_pattern({"Views", std::nullopt, "Hierarchy", "Hierarchy"}))
            hierarchyPaths.push_back({parts[1], entry.path()});
        else
            others.push_back(entry.path());
    }

    if(!libPath)
    {
        throw InputError{EXIT_NO_DATA,
            "no Library stream in this CFBF container: it is not an OrCAD Capture design or library"};
    }

    LibraryRec lib = readLibrary(ctx, *libPath);
    if(!lib.ok)
    {
        throw InputError{EXIT_NO_DATA,
            "the Library stream could not be read: not an OrCAD Capture file, or a format version this parser does not "
            "know (very old files are one known case)"};
    }

    const bool oldFormat = lib.version.rfind("2.", 0) == 0;

    // Symbols and packages. The Cache comes first: it holds the copy each
    // instance in the design was placed from, and later entries of the same
    // name are older copies under Packages/ (Y3 of BeagleBoard-xM is one case:
    // the Cache has its 2 pins, Packages/ still has 4).
    SymbolStore store;
    bool cacheOk = true;
    for(const auto& path : others)
    {
        CfbfStreamLocation loc{path, root};
        if(!loc.matches_pattern({"Cache"}))
            continue;
        try
        {
            readCacheStream(ctx, path, store, lib.strLst, oldFormat);
        }
        catch(const std::exception& e)
        {
            cacheOk = false;
            gWarnings.add(fmt::format(
                "Cache stream was read only in part, symbols after that point are missing: {}", e.what()));
        }
    }

    size_t packageFailures = 0;
    size_t packageCopies   = 0;
    for(const auto& path : packages)
    {
        const std::string streamName = path.stem().string();

        // Capture leaves these temporary copies behind. "Packages Directory"
        // does not list them, and their content is not a package record.
        if(streamName.find("_pDboPackage_Copy_") != std::string::npos)
        {
            ++packageCopies;
            continue;
        }

        try
        {
            if(oldFormat)
                oldPackageStream(ctx, path, store, lib.strLst);
            else
                readPackageStream(ctx, path, store, lib.strLst);
        }
        catch(const std::exception& e)
        {
            ++packageFailures;
            gWarnings.add(fmt::format("package \"{}\" could not be read, its pin names and numbers are missing: {}",
                streamName, e.what()));
        }
    }

    // Library files keep power, port and off-page symbols in Symbols/<name>.
    for(const auto& path : others)
    {
        CfbfStreamLocation loc{path, root};
        if(!loc.matches_pattern({"Symbols", std::nullopt}))
            continue;
        const std::string name = loc.get_vector().back();
        if(name == "$Types$" || name == "ERC" || name == "ERC_PHYSICAL")
            continue;
        try
        {
            StreamContext sctx{ctx, path};
            GenericParser parser{sctx};
            if(oldFormat)
                store.symbols.push_back(oldSymbol(sctx.mDs, "Symbols/" + name, lib.strLst));
            else
                store.readSymbol(sctx, parser, "Symbols/" + name, lib.strLst);
        }
        catch(const std::exception& e)
        {
            gWarnings.add(fmt::format("symbol \"{}\" could not be read: {}", name, e.what()));
        }
    }

    // Pages, in schematic order.
    std::map<std::string, std::vector<std::string>> order;
    for(const auto& [view, path] : schematicPaths)
    {
        if(oldFormat)
            continue;
        try
        {
            order[view] = readSchematicPageOrder(ctx, path);
        }
        catch(const std::exception& e)
        {
            gWarnings.add(fmt::format("schematic \"{}\": its page list could not be read: {}", view, e.what()));
        }
    }

    std::vector<PageRec> pages;
    for(const auto& [view, path] : pagePaths)
    {
        try
        {
            pages.push_back(oldFormat ? oldPage(ctx, path, view, lib.strLst) : readPage(ctx, path, view));
        }
        catch(const std::exception& e)
        {
            gWarnings.add(fmt::format("page stream \"{}\" could not be read and is missing from the result: {}",
                path.stem().string(), e.what()));
        }
    }

    std::stable_sort(pages.begin(), pages.end(),
        [](const PageRec& a, const PageRec& b)
        {
            if(a.view != b.view)
                return naturalLess(a.view, b.view);
            return naturalLess(a.name, b.name);
        });

    for(const auto& [view, names] : order)
    {
        for(const auto& name : names)
        {
            const bool found = std::any_of(
                pages.begin(), pages.end(), [&](const PageRec& p) { return p.view == view && p.name == name; });
            if(!found)
                gWarnings.add(fmt::format("page \"{}\" is listed in the schematic but was not read", name));
        }
    }

    // Capture's own table of the flattened design.
    std::vector<HierarchyRec> hierarchies;
    for(const auto& [view, path] : hierarchyPaths)
    {
        if(oldFormat)
            break;
        HierarchyRec rec;
        rec.view  = view;
        bool done = false;
        for(int bits = 0; bits < 16 && !done; ++bits)
            done = tryReadHierarchy(ctx, path, bits, rec);
        if(done)
            hierarchies.push_back(std::move(rec));
        else
            gWarnings.add(fmt::format("hierarchy table of \"{}\" could not be read: it is only used as a cross check", view));
    }

    // All the rest: parse to report honestly what the parser can not read.
    size_t otherOk = 0;
    std::map<std::string, size_t> notParsed;
    std::vector<std::string> failedStreams;
    if(oldFormat)
    {
        gWarnings.add(fmt::format("old format (Library version {}): read by this tool's own layout, without length prefixes to "
                                  "check against. Graphics, ERC markers and the hierarchy table are not read",
            lib.version));
    }
    for(const auto& path : oldFormat ? std::vector<fs::path>{} : others)
    {
        CfbfStreamLocation loc{path, root};
        const std::string label = loc.get_vector().empty() ? path.string() : loc.get_vector().front();
        if(loc.matches_pattern({"Cache"}))
            continue;
        std::unique_ptr<Stream> stream;
        try
        {
            stream = StreamFactory::build(ctx, path);
        }
        catch(const std::exception&)
        {
        }
        if(!stream)
        {
            ++notParsed[label];
            continue;
        }
        try
        {
            stream->read();
            ++otherOk;
        }
        catch(const std::exception& e)
        {
            failedStreams.push_back(fmt::format("{} ({})", label, e.what()));
        }
    }

    for(const auto& [label, count] : notParsed)
        gWarnings.add(fmt::format("parser has no reader for {} stream(s) under \"{}\"", count, label));
    for(const auto& failed : failedStreams)
        gWarnings.add(fmt::format("stream not understood: {}", failed));

    // A library without any part is not an error. Streams that exist but could
    // not be read are.
    const bool anythingToRead = !pagePaths.empty() || packages.size() > packageCopies;
    if(pages.empty() && store.packages.empty() && store.symbols.empty() && anythingToRead)
    {
        std::string why;
        for(size_t i = 0; i < gWarnings.list().size() && i < 4; ++i)
            why += "\n  " + gWarnings.list()[i];
        throw InputError{EXIT_NO_DATA,
            fmt::format("the file holds no page and no package that could be read (Library version {}).{}", lib.version, why)};
    }

    if(pages.size() != pagePaths.size())
    {
        gWarnings.add(
            fmt::format("{} of {} pages could not be read", pagePaths.size() - pages.size(), pagePaths.size()));
    }

    computeHotPoints(pages, store.symbols);

    std::map<std::string, const SymbolRec*> partSymbols;
    std::vector<const SymbolRec*> uniqueSymbols;
    {
        std::set<std::pair<std::string, std::string>> seen;
        for(const auto& sym : store.symbols)
        {
            if(sym.kind == "part")
                partSymbols.emplace(sym.name, &sym);
            if(seen.insert({sym.kind, sym.name}).second)
                uniqueSymbols.push_back(&sym);
        }
    }

    const bool isDesign = lib.type == DatabaseType::Design;

    std::string out = "{";
    out += fmt::format(R"("kind":{},"file":{},)", jstr(isDesign ? "dsn" : "olb"), jstr(aDisplayName));
    out += fmt::format(R"("format":{{"introduction":{},"version":{},"strings":{},"created":{},"modified":{}}},"rootSchematic":{},)",
        jstr(lib.introduction), jstr(lib.version), lib.strLst.size(), static_cast<long long>(lib.created),
        static_cast<long long>(lib.modified), jstr(lib.rootSchematic));
    out += R"("pages":)" + jarr(pages, [&](const PageRec& p) { return pageJson(p, lib); }) + ",";

    out += R"("parts":)" + jarr(store.packages, [&](const PackageRec& p) { return packageJson(p, partSymbols, lib.strLst); }) + ",";

    out += R"("symbols":)" + jarr(uniqueSymbols, [&](const SymbolRec* s) { return symbolJson(*s, lib.strLst); }) + ",";

    out += R"("partAliases":)" + jarr(lib.partAliases, [](const std::pair<std::string, std::string>& a)
                                     { return fmt::format(R"({{"alias":{},"package":{}}})", jstr(a.first), jstr(a.second)); }) + ",";

    out += R"("hierarchy":)" + jarr(hierarchies, [](const HierarchyRec& h)
    {
        return fmt::format(R"({{"view":{},"pages":{},"offPages":{},"instances":{},"nets":{}}})", jstr(h.view), h.pages,
            h.offPages, h.instances,
            jarr(h.nets, [](const std::pair<uint32_t, std::string>& n)
                { return fmt::format(R"({{"id":{},"name":{}}})", n.first, jstr(n.second)); }));
    }) + ",";

    out += fmt::format(
        R"("stats":{{"streams":{},"pagesRead":{},"packagesRead":{},"packagesFailed":{},"packageCopiesIgnored":{},"cacheComplete":{},"otherStreamsRead":{}}},)",
        streamCount, pages.size(), store.packages.size(), packageFailures, packageCopies, cacheOk ? "true" : "false", otherOk);

    if(packageCopies > 0)
    {
        gWarnings.add(fmt::format(
            "ignored {} leftover \"_pDboPackage_Copy_\" streams: not listed in Packages Directory and not package records",
            packageCopies));
    }

    out += R"("warnings":)" + jarr(gWarnings.list(), [](const std::string& s) { return jstr(s); });
    out += "}\n";

    std::cout << out;
    std::cout.flush();

    if(gVerbose)
    {
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
        std::cerr << fmt::format("orcad2json: {} pages, {} packages, {} symbols, {} streams in {} ms\n", pages.size(),
            store.packages.size(), uniqueSymbols.size(), streamCount, ms);
    }

    return EXIT_OK;
}

pid_t gChild = -1;

void forwardSignal(int)
{
    if(gChild > 0)
        kill(gChild, SIGKILL);
}

void usage()
{
    std::cerr << "usage: orcad2json <file.dsn|file.olb> [--raw] [--verbose]\n"
                 "Prints the file content as JSON on stdout. Logs and errors go to stderr.\n";
}
} // namespace

int main(int argc, char* argv[])
{
    std::string inputArg;
    for(int i = 1; i < argc; ++i)
    {
        const std::string arg = argv[i];
        if(arg == "--raw")
        {
            gRaw = true;
        }
        else if(arg == "--verbose" || arg == "-v")
        {
            gVerbose = true;
        }
        else if(arg == "--help" || arg == "-h")
        {
            usage();
            return EXIT_USAGE;
        }
        else if(!arg.empty() && arg[0] == '-')
        {
            std::cerr << "orcad2json: unknown option " << arg << "\n";
            usage();
            return EXIT_USAGE;
        }
        else if(inputArg.empty())
        {
            inputArg = arg;
        }
        else
        {
            usage();
            return EXIT_USAGE;
        }
    }

    if(inputArg.empty())
    {
        usage();
        return EXIT_USAGE;
    }

    std::error_code ec;
    if(!fs::exists(inputArg, ec))
    {
        std::cerr << "orcad2json: " << inputArg << ": file not found\n";
        return EXIT_BAD_INPUT;
    }
    if(!fs::is_regular_file(inputArg, ec))
    {
        std::cerr << "orcad2json: " << inputArg << ": not a regular file\n";
        return EXIT_BAD_INPUT;
    }

    const fs::path input = fs::absolute(inputArg);
    const std::string displayName = fs::path{inputArg}.filename().string();

    // Everything the parser writes goes into one private directory.
    std::string tmpl = (fs::temp_directory_path() / "orcad2json.XXXXXX").string();
    if(mkdtemp(tmpl.data()) == nullptr)
    {
        std::cerr << "orcad2json: cannot create a temporary directory: " << std::strerror(errno) << "\n";
        return EXIT_CRASH;
    }
    const fs::path workDir{tmpl};

    const auto cleanup = [&]()
    {
        std::error_code ignored;
        fs::remove_all(workDir, ignored);
    };

    std::cout.flush();
    std::cerr.flush();

    const pid_t pid = fork();
    if(pid < 0)
    {
        std::cerr << "orcad2json: fork failed: " << std::strerror(errno) << "\n";
        cleanup();
        return EXIT_CRASH;
    }

    if(pid == 0)
    {
        setenv("TMPDIR", workDir.c_str(), 1);
        if(chdir(workDir.c_str()) != 0)
            _exit(EXIT_CRASH);

        // Guard against the parser looping on garbage.
        alarm(600);

        int code = EXIT_CRASH;
        try
        {
            code = run(input, displayName);
        }
        catch(const InputError& e)
        {
            std::cerr << "orcad2json: " << inputArg << ": " << e.what() << "\n";
            code = e.code;
        }
        catch(const std::exception& e)
        {
            std::cerr << "orcad2json: " << inputArg << ": cannot read this file: " << e.what() << "\n";
            code = EXIT_NO_DATA;
        }
        std::cout.flush();
        std::cerr.flush();
        _exit(code);
    }

    gChild = pid;
    std::signal(SIGINT, forwardSignal);
    std::signal(SIGTERM, forwardSignal);

    int status = 0;
    while(waitpid(pid, &status, 0) < 0)
    {
        if(errno != EINTR)
            break;
    }

    cleanup();

    if(WIFEXITED(status))
    {
        // The child itself never exits with 1. ContainerExtractor::dumpBuffer() calls
        // std::exit(1) when a stream cannot be written, which damaged names can cause.
        if(WEXITSTATUS(status) == EXIT_USAGE)
        {
            std::cerr << "orcad2json: " << inputArg << ": the container could not be extracted, the file looks damaged\n";
            return EXIT_BAD_INPUT;
        }
        return WEXITSTATUS(status);
    }

    if(WIFSIGNALED(status))
    {
        const int sig = WTERMSIG(status);
        if(sig == SIGALRM)
            std::cerr << "orcad2json: " << inputArg << ": gave up after 600 s, the parser did not finish on this file\n";
        else
            std::cerr << "orcad2json: " << inputArg << ": the parser crashed on this file (signal " << sig
                      << "). The file may be damaged or of a format version the parser does not know\n";
    }
    return EXIT_CRASH;
}
