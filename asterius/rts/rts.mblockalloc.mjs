import * as rtsConstants from "./rts.constants.mjs";
import { Memory } from "./rts.memory.mjs";

// check that a megablock is correctly aligned
function assertMblockAligned(mb) {
    const n = Math.log2(rtsConstants.mblock_size);
    if ((BigInt(mb) >> BigInt(n)) << BigInt(n) != BigInt(mb)) {
      throw new WebAssembly.RuntimeError(`mb(${mb}) not aligned to 2^${n} (${rtsConstants.mblock_size})`);
    };
}

// check that a block descriptor is correctly aligned
function assertBdescrAligned(bd) {
    assertMblockAligned(bd - rtsConstants.offset_first_bdescr);
}

export class MBlockAlloc {
  constructor() {
    this.memory = undefined;
    this.staticMBlocks = undefined;
    this.capacity = undefined;
    this.size = undefined;
    // Contains segments of the form [(l, r)] of free memory.
    // invariant: l is a legal block descriptor, and therefore
    // satisfies assertBdescrAligned
    this.freeSegments = [];
    Object.seal(this);
  }

  init(memory, static_mblocks) {
    this.memory = memory;
    this.staticMBlocks = static_mblocks;
    this.capacity = this.memory.buffer.byteLength / rtsConstants.mblock_size;
    this.size = this.capacity;
  }

  getMBlocks(n) {
    if (this.size + n > this.capacity) {
      const d = Math.max(n, this.capacity);
      this.memory.grow(d * (rtsConstants.mblock_size / rtsConstants.pageSize));
      this.capacity += d;
    }
    const prev_size = this.size;
    this.size += n;
    return Memory.tagData(prev_size * rtsConstants.mblock_size);
  }

  setupBdescr(bd, start, nblocks) {
    this.memory.i64Store(bd + rtsConstants.offset_bdescr_start, start);
    this.memory.i64Store(bd + rtsConstants.offset_bdescr_free, start);
    this.memory.i64Store(bd + rtsConstants.offset_bdescr_link, 0);
    this.memory.i32Store(bd + rtsConstants.offset_bdescr_blocks, nblocks);
  }

  allocMegaGroup(n) {
    const req_blocks = 
          Math.ceil(((rtsConstants.mblock_size * n) - rtsConstants.offset_first_block) / 
          rtsConstants.block_size);

    for (let i = 0; i < this.freeSegments.length; ++i) {
      const [mblock, r] = this.freeSegments[i];
      assertMblockAligned(mblock);
      const bd = mblock + rtsConstants.offset_first_bdescr;
      const start = mblock + rtsConstants.offset_first_block;
      const blocks = Math.floor((r - start) / rtsConstants.block_size);

      // we have enough blocks, so we should initialize bd
      if (req_blocks <= blocks) {
        this.setupBdescr(bd, start, req_blocks);
      }
    
      if (req_blocks < blocks) {
        this.memory.i32Store(bd + rtsConstants.offset_bdescr_blocks, req_blocks);
        const rest_mblock = mblock + (rtsConstants.mblock_size * n);
        assertMblockAligned(rest_mblock);
        this.freeSegments.splice(i, 1, [rest_mblock, r]);
      }


      if (req_blocks == blocks) {
        this.freeSegments.splice(i, 1);
        return bd;
      }
    }

    const mblock = this.getMBlocks(n),
          bd = mblock + rtsConstants.offset_first_bdescr,
          block_addr = mblock + rtsConstants.offset_first_block;
    this.setupBdescr(bd, block_addr, req_blocks);
    return bd;
  }

  freeSegment(i, l_end, r) {
    if (l_end < r) {
        // memset a custom number purely for debugging help.
        this.memory.memset(l_end, 0x42 + i, r - l_end);
        assertMblockAligned(l_end);
        this.freeSegments.push([l_end, r])
    }
  }

  preserveMegaGroups(bds) {
    this.freeSegments = [];
    const sorted_bds = Array.from(bds).sort((bd0, bd1) => bd0 - bd1);
    this.freeSegment(0, 
        Memory.tagData(rtsConstants.mblock_size * this.staticMBlocks),
        sorted_bds[0] - rtsConstants.offset_first_bdescr);
    for (let i = 0; i < (sorted_bds.length-1); ++i) {
      const l_start = Number(
          this.memory.i64Load(sorted_bds[i] + rtsConstants.offset_bdescr_start)),
      l_blocks =
          this.memory.i32Load(sorted_bds[i] + rtsConstants.offset_bdescr_blocks),
      l_end = l_start + (rtsConstants.block_size * l_blocks),
      r = sorted_bds[i + 1] - rtsConstants.offset_first_bdescr;
      this.freeSegment(i+1, l_end, r);
    }
  }
}
