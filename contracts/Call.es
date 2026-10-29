{
  // Call.es: the covered call as a timed escrow (skunkyard SK-065). A box of tokens that is a standing offer: the
  // writer has locked the underlying and named the strike, the expiry height and the premium. Anyone may buy the
  // option by paying the premium to the writer; the named buyer may then exercise at the strike at or before the
  // expiry; the writer takes the underlying back after the expiry, or at any time while the option is unsold.
  // TokenJay's escrow with an offer-to-write step, a deadline that locks the writer, and no fee line. The buyer is an
  // address in a register, not a token: the right is not transferable (SigmaO and Etcha are the token-based options).
  //
  // REGISTERS (R4 to R6 never change; R7 is written once, by the buy)
  //   R4: SigmaProp, the writer. Spends the box under their key while it is unsold, or after the expiry.
  //   R5: Coll[Byte], the underlying token id; the box's first token.
  //   R6: Coll[Long], the terms: (amount, strike, expiry, premium)
  //       amount   units of the underlying the option is on (what the box holds)
  //       strike   nanoERG per smallest unit the buyer pays on exercise
  //       expiry   the last height at which the option may be exercised; the writer reclaims from the next
  //       premium  nanoERG anyone pays the writer to become the buyer
  //   R7: SigmaProp, the buyer; absent until the option is sold.
  //
  // BUY (no key, while unsold, at or before the expiry): context variable 0 names the premium output, 1 the
  //   successor. The premium output carries at least the premium to the writer with R4 = this box's id; the
  //   successor carries this box's value, tokens and R4 to R6 unchanged, and a buyer in R7. One option box per
  //   transaction, so one successor answers one box.
  // EXERCISE (the buyer's key, at or before the expiry): context variable 0 names the writer's output, 1 the
  //   buyer's. The writer's output carries this box's value plus strike x amount with R4 = this box's id; the
  //   buyer's output carries the underlying with R4 = this box's id. No partial exercise.
  // WRITER (the writer's key): any time while unsold; after the expiry once sold. No output rule: everything back.
  val writer = SELF.R4[SigmaProp].get
  val tokenId = SELF.R5[Coll[Byte]].get
  val terms = SELF.R6[Coll[Long]].get
  val amount = terms(0)
  val strike = terms(1)
  val expiry = terms(2)
  val premium = terms(3)
  val buyer = SELF.R7[SigmaProp]
  val sold = buyer.isDefined
  val open = HEIGHT.toLong <= expiry
  val firstIdx = getVar[Int](0)
  val onlyOne = INPUTS.filter { (b: Box) => b.propositionBytes == SELF.propositionBytes }.size == 1

  val buy = if (!sold && firstIdx.isDefined) {
    val pay = OUTPUTS(firstIdx.get)
    val next = OUTPUTS(getVar[Int](1).get)
    allOf(Coll(
      open,
      onlyOne,
      pay.propositionBytes == writer.propBytes,
      pay.value >= premium,
      pay.R4[Coll[Byte]].get == SELF.id,
      next.propositionBytes == SELF.propositionBytes,
      next.value >= SELF.value,
      next.tokens == SELF.tokens,
      next.R4[SigmaProp].get == writer,
      next.R5[Coll[Byte]].get == tokenId,
      next.R6[Coll[Long]].get == terms,
      next.R7[SigmaProp].isDefined
    ))
  } else false

  val exercise = if (sold && firstIdx.isDefined) {
    val pay = OUTPUTS(firstIdx.get)
    val get = OUTPUTS(getVar[Int](1).get)
    buyer.get && sigmaProp(allOf(Coll(
      open,
      onlyOne,
      pay.propositionBytes == writer.propBytes,
      pay.value >= SELF.value + strike * amount,
      pay.R4[Coll[Byte]].get == SELF.id,
      get.propositionBytes == buyer.get.propBytes,
      get.tokens(0)._1 == tokenId,
      get.tokens(0)._2 >= amount,
      get.R4[Coll[Byte]].get == SELF.id
    )))
  } else sigmaProp(false)

  (writer && sigmaProp(!sold || !open)) || sigmaProp(buy) || exercise
}
