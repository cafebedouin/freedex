{
  // Put.es: the cash-secured put, the mirror of Call.es (skunkyard SK-065). A box of ERG that is a standing offer:
  // the writer has locked the collateral (strike x amount) and named the strike, the expiry height and the premium.
  // Anyone may buy the option by paying the premium to the writer; the named buyer may then exercise at or before
  // the expiry by delivering the underlying to the writer and taking the collateral; the writer takes the collateral
  // back after the expiry, or at any time while the option is unsold. Every rule of Call.es with the sides swapped:
  // the box holds ERG, not tokens; on exercise the tokens go to the writer and the box's ERG to the buyer.
  //
  // REGISTERS (R4 to R6 never change; R7 is written once, by the buy)
  //   R4: SigmaProp, the writer.
  //   R5: Coll[Byte], the underlying token id, what the buyer delivers on exercise; the box holds none of it.
  //   R6: Coll[Long], the terms: (amount, strike, expiry, premium)
  //       amount   units of the underlying the buyer delivers on exercise
  //       strike   nanoERG per smallest unit; the box holds strike x amount, the collateral
  //       expiry   the last height at which the option may be exercised; the writer reclaims from the next
  //       premium  nanoERG anyone pays the writer to become the buyer
  //   R7: SigmaProp, the buyer; absent until the option is sold.
  //
  // BUY (no key, while unsold, at or before the expiry): as Call.es; the successor keeps the box's value and tokens.
  // EXERCISE (the buyer's key, at or before the expiry): context variable 0 names the writer's output, 1 the
  //   buyer's. The writer's output carries the underlying with R4 = this box's id; the buyer's output carries this
  //   box's value with R4 = this box's id.
  // WRITER (the writer's key): any time while unsold; after the expiry once sold. No output rule: everything back.
  val writer = SELF.R4[SigmaProp].get
  val tokenId = SELF.R5[Coll[Byte]].get
  val terms = SELF.R6[Coll[Long]].get
  val amount = terms(0)
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
      pay.tokens(0)._1 == tokenId,
      pay.tokens(0)._2 >= amount,
      pay.R4[Coll[Byte]].get == SELF.id,
      get.propositionBytes == buyer.get.propBytes,
      get.value >= SELF.value,
      get.R4[Coll[Byte]].get == SELF.id
    )))
  } else sigmaProp(false)

  (writer && sigmaProp(!sold || !open)) || sigmaProp(buy) || exercise
}
